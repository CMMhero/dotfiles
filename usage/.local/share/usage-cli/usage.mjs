#!/usr/bin/env node
// ==============================================================================
// usage.mjs - agent token and dollar totals, collected per host and merged.
//
// The numbers come from herdr-app's Insights collectors, which already parse the
// local logs of pi, omp, Codex, opencode and Claude Code. That mod is managed by
// chezmoi, so its adapters are the parsers; this CLI only runs them, publishes a
// per-host snapshot, and merges the snapshots.
//
//   usage                     totals from every host file in the usage folder
//   usage collect             scan this host and, on Windows, its WSL distro
//   usage web                 browser dashboard on loopback (usage-web.mjs)
//   usage hosts               what has been published and when
//   usage prices update       refresh model prices from OpenRouter
//
// Layout:
//   D:\Usage\<host>.json      one snapshot per host, synced by Syncthing
//   D:\Usage\prices.json      price cache, shared by every host
//   %LOCALAPPDATA%\usage\     this host's incremental collector store
//   ~/.local/state/usage/     the same on WSL
//
// A row is a per-day aggregate keyed by session, harness, provider, model and
// project, matching the app's own row identity. A session that moves between
// directories produces one row per project, so the project belongs in the key.
// Two hosts can only share a row when a session was resumed on both, so merging
// takes the larger copy of a row instead of summing: the same transcript counted
// twice must not double the bill.
//
// Token fields follow the app's convention: `output` does NOT include
// `reasoning`, and `reasoning` is reported beside it, never added to `total`.
// Atuin's threads.db records the opposite (`usage_output` includes reasoning),
// which is why the same session reads ~5% higher there. Any comparison with
// `atuin threads` has to subtract `usage_reasoning` from `usage_output` first.
// ==============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atuinSnapshots } from "./usage-atuin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR = path.join(SCRIPT_DIR, "dot_config", "herdr-app", "mods", "insights", "collector.mjs");

// Overrides are chezmoi-managed config, so the deployed copy wins when it is
// there; WSL falls back to the repo because its own dotfiles are separate.
function priceOverridesPath() {
  if (process.env.USAGE_PRICES) return process.env.USAGE_PRICES;
  const deployed = path.join(os.homedir(), ".config", "usage", "prices.json");
  if (existsSync(deployed)) return deployed;
  return path.join(SCRIPT_DIR, "dot_config", "usage", "prices.json");
}
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const PRICE_TTL_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------------------
// Paths and host identity
// ------------------------------------------------------------------------------

function usageDir() {
  if (process.env.USAGE_DIR) return path.resolve(process.env.USAGE_DIR);
  if (process.platform === "win32") return "D:\\Usage";
  // WSL sees the Windows share here; the Windows side does the Syncthing work.
  if (existsSync("/mnt/d/Usage")) return "/mnt/d/Usage";
  return path.join(os.homedir(), "Usage");
}

function stateDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "usage");
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "usage");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function hostId(platform = process.platform) {
  // Three outcomes, not two: WSL is this PC's Linux half, while the VPS boxes
  // are separate machines. Labelling every Linux host "-wsl" published the
  // remote ones under this PC's name and merged two machines' numbers.
  //
  // The suffix is only added when the hostname does not already say it. A distro
  // whose hostname is `cmmhero-pc-wsl` used to publish as
  // `cmmhero-pc-wsl-wsl`, and when the hostname changed the id changed with it,
  // leaving the old file in the share: 54 rows counted twice under two names.
  const host = slug(os.hostname());
  const suffix = platform === "win32" ? "win" : isWsl() ? "wsl" : "linux";
  const stem = host.endsWith(`-${suffix}`) ? host.slice(0, -(suffix.length + 1)) : host;
  return `${stem || host}-${suffix}`;
}

function hostFile(host = hostId()) {
  return path.join(usageDir(), `${host}.json`);
}

function atomicWriteJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`);
  renameSync(temp, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------------------
// Collect - run the insights collector for one host, publish its rows
// ------------------------------------------------------------------------------

function collectorSnapshot({ rebuild = false } = {}) {
  if (!existsSync(COLLECTOR)) {
    throw new Error(`insights collector not found at ${COLLECTOR}`);
  }
  const store = path.join(stateDir(), "insights-store.json");
  const args = [COLLECTOR, "snapshot", "--store", store];
  if (rebuild) args.push("--rebuild");
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `collector exited ${result.status}`).trim());
  }
  const snapshot = JSON.parse(result.stdout);
  if (!Array.isArray(snapshot.rows)) throw new Error("collector returned no rows");
  return snapshot;
}

function collectLocal({ rebuild = false, stdout = false } = {}) {
  const snapshot = collectorSnapshot({ rebuild });
  const file = hostFile();
  const payload = {
    schema: 1,
    host: hostId(),
    platform: process.platform === "win32" ? "windows" : isWsl() ? "wsl" : "linux",
    hostname: os.hostname(),
    collectedAt: new Date().toISOString(),
    stats: snapshot.stats ?? null,
    rows: snapshot.rows,
  };

  // --stdout is what the hub uses to pull a remote host: the scan happens on
  // the machine that owns the logs, the file is written where the share lives.
  // A remote needs no Syncthing share, no USAGE_DIR, and no writable D:.
  if (stdout) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return payload;
  }

  atomicWriteJson(file, payload);
  const messages = payload.rows.reduce((sum, row) => sum + (row.messages ?? 0), 0);
  console.log(`collected ${payload.rows.length} rows, ${messages} messages from ${payload.host}`);
  console.log(`  -> ${file}`);
  return payload;
}

// Windows drives its own WSL distro, so one `usage collect` covers both halves
// of the machine. Nothing is installed on the Linux side: it runs this same
// file through its own Node, with the Linux home and /mnt/d/Usage as the share.
function collectWsl() {
  if (process.platform !== "win32") return null;

  const list = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "buffer" });
  if (list.error || list.status !== 0) return null;
  // wsl.exe writes UTF-16LE here, so decoding as utf8 yields NULs.
  const distro = list.stdout.toString("utf16le").split(/\r?\n/).map((line) => line.replace(/\0/g, "").trim()).find(Boolean);
  if (!distro) return null;

  const translated = spawnSync("wsl.exe", ["-d", distro, "-e", "wslpath", "-a", SCRIPT_DIR], { encoding: "utf8" });
  if (translated.status !== 0 || !translated.stdout.trim()) {
    console.log(`wsl (${distro}): could not translate ${SCRIPT_DIR}`);
    return null;
  }
  const script = path.posix.join(translated.stdout.trim(), "usage.mjs");

  const probe = spawnSync("wsl.exe", ["-d", distro, "-e", "sh", "-lc", 'command -v node || printf %s "$HOME/.local/share/vite-plus/bin/node"'], { encoding: "utf8" });
  const node = (probe.stdout || "").trim();
  if (probe.status !== 0 || !node) {
    console.log(`wsl (${distro}): no node found, skipping`);
    return null;
  }

  const run = spawnSync("wsl.exe", ["-d", distro, "-e", node, script, "collect", "--local-only"], { encoding: "utf8" });
  if (run.status !== 0) {
    console.error(`wsl (${distro}): collect failed`);
    if (run.stderr) console.error(run.stderr.trim());
    return null;
  }
  process.stdout.write(run.stdout);
  return true;
}

// ------------------------------------------------------------------------------
// Remote Linux hosts - the SSH aliases already in ~/.ssh/config
// ------------------------------------------------------------------------------

// Machines that keep agent logs of their own. This is the one list to edit when
// another box joins: the alias must already work without a password prompt
// (`ssh dev true`), because a scheduled task has nobody to type one.
//
// space-pp is listed with its user because its tailnet ACL permits `it` and
// nothing else: `ssh space-pp` authenticates as the Windows account name and the
// policy closes the connection with `tailnet policy does not permit you to SSH
// as user "cmm"`. The `space` alias in ~/.ssh/config points at the same box over
// its public IP, which no longer accepts connections, so the tailnet path is the
// only one that works.
const REMOTE_HOSTS = (process.env.USAGE_REMOTE_HOSTS ?? "main,dev,it@space-pp")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

// Where the tool lands on the far side. Under XDG state, not a temp dir: the
// collector keeps an incremental store, and a copy that vanishes between runs
// would rescan every transcript from scratch each time.
function remoteToolDir(home = "~") {
  return `${home}/.local/share/usage/tool`;
}

// The collector is a directory of ES modules, so a single file cannot be copied
// across. tar over ssh keeps the tree and needs nothing installed on either end
// (rsync is absent on both VPS boxes). Windows' bsdtar writes a POSIX ustar
// archive; GNU tar on the far side reads it.
function pushTool(host) {
  const local = spawnSync("tar", ["-czf", "-", "-C", SCRIPT_DIR, "usage.mjs", "usage-atuin.mjs", "usage-env.mjs", "usage-threads.mjs", "dot_config/herdr-app/mods/insights"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (local.status !== 0) {
    throw new Error(`tar failed: ${(local.stderr || "").toString().trim()}`);
  }

  const remote = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
     `mkdir -p ${remoteToolDir()} && tar -xzf - -C ${remoteToolDir()}`],
    { input: local.stdout, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (remote.status !== 0) {
    throw new Error((remote.stderr || remote.stdout || `ssh exited ${remote.status}`).toString().trim());
  }
}

function collectRemote(host) {
  // ALWAYS push: the parsers change with the dotfiles repo, and a stale copy on
  // the far side would silently report yesterday's numbers forever.
  pushTool(host);

  // vite+ owns node on these boxes and puts it here; PATH in a non-login ssh
  // command is minimal, so the known location is probed explicitly after the
  // plain lookup fails.
  const probe = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
     'command -v node || ls "$HOME/.local/share/vite-plus/bin/node" 2>/dev/null || echo'],
    { encoding: "utf8" },
  );
  const node = (probe.stdout || "").trim().split(/\r?\n/).pop();
  if (probe.status !== 0 || !node) {
    console.log(`${host}: no node found, skipping`);
    return null;
  }

  const run = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
     `${node} ${remoteToolDir()}/usage.mjs collect --local-only --stdout`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    console.error(`${host}: collect failed`);
    if (run.stderr) console.error(run.stderr.trim());
    return null;
  }

  // The payload is written HERE, against the share, so the remote needs no
  // mount of D: and no Syncthing folder of its own.
  let payload;
  try {
    payload = JSON.parse(run.stdout);
  } catch {
    console.error(`${host}: collector returned something that is not JSON`);
    if (run.stderr) console.error(run.stderr.trim());
    return null;
  }
  if (!payload?.host || !Array.isArray(payload.rows)) {
    console.error(`${host}: collector payload missing host or rows`);
    return null;
  }

  const file = path.join(usageDir(), `${payload.host}.json`);
  atomicWriteJson(file, payload);
  const messages = payload.rows.reduce((sum, row) => sum + (row.messages ?? 0), 0);
  console.log(`collected ${payload.rows.length} rows, ${messages} messages from ${payload.host}`);
  console.log(`  -> ${file}`);
  return true;
}

function collectRemotes() {
  let pulled = 0;
  for (const host of REMOTE_HOSTS) {
    try {
      if (collectRemote(host)) pulled += 1;
    } catch (error) {
      // A machine that is off is normal, not a failure of the run. The snapshot
      // it published last stays in the share and `usage hosts` shows its age.
      console.log(`${host}: ${error.message}`);
    }
  }
  return pulled;
}

// ------------------------------------------------------------------------------
// Prices - USD per million tokens, from OpenRouter, cached in the share
// ------------------------------------------------------------------------------

const FREE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function normalizeId(id) {
  return String(id)
    .toLowerCase()
    .replace(/:(free|batch)$/, "")
    .replace(/-(free|batch)$/, "")
    .replace(/^.*\//, "")
    .replace(/[^a-z0-9]/g, "");
}

function loadOverrides() {
  return readJson(priceOverridesPath(), { aliases: {}, models: {} });
}

function loadPriceCache() {
  return readJson(path.join(usageDir(), "prices.json"), null);
}

async function refreshPrices() {
  const response = await fetch(OPENROUTER_MODELS, {
    headers: { "User-Agent": "dotfiles-win-usage" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
  const body = await response.json();
  const models = {};
  for (const entry of body.data ?? []) {
    const pricing = entry.pricing ?? {};
    const perMillion = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n * 1_000_000 : null;
    };
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    if (input === null && output === null) continue;
    models[entry.id] = {
      input,
      output,
      cacheRead: perMillion(pricing.input_cache_read) ?? input,
      cacheWrite: perMillion(pricing.input_cache_write) ?? input,
    };
  }
  const file = path.join(usageDir(), "prices.json");
  atomicWriteJson(file, { source: "openrouter", fetchedAt: new Date().toISOString(), models });
  return { file, count: Object.keys(models).length };
}

function priceIndex() {
  const cache = loadPriceCache();
  const overrides = loadOverrides();
  const byId = new Map();
  const byNorm = new Map();
  const add = (id, price) => {
    if (!price) return;
    byId.set(String(id).toLowerCase(), price);
    const norm = normalizeId(id);
    if (!norm) return;
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push({ id, price });
  };
  for (const [id, price] of Object.entries(cache?.models ?? {})) add(id, price);
  for (const [id, price] of Object.entries(overrides.models ?? {})) add(id, price);
  return { byId, byNorm, aliases: overrides.aliases ?? {}, cache };
}

const ENTRIES = ["input", "output", "cacheRead", "cacheWrite"];

// Zero for a free tier, otherwise the model's own prices; null when unknown.
//
// "Free" is not only a `:free`/`-free` suffix. Provider-scoped tiers put it in
// the middle of the id (`cline-free/step-5-preview`, 371 messages here), and a
// bare `openrouter/free` ends the id without either separator. Anchoring only
// at the end billed $10.07 of free-tier usage as paid.
const FREE_TIER = /(^|[/])free$|[:/-]free(?=[/:._-]|$)/i;

function priceFor(model, provider, index) {
  if (!model) return null;
  if (FREE_TIER.test(model)) return FREE;

  const alias = index.aliases[model] || index.aliases[model.toLowerCase()];
  if (alias) {
    const direct = index.byId.get(String(alias).toLowerCase());
    if (direct) return direct;
  }

  const direct = index.byId.get(String(model).toLowerCase());
  if (direct) return direct;

  const withVendor = String(provider || "").toLowerCase();
  if (withVendor && !model.includes("/")) {
    const prefixed = index.byId.get(`${withVendor}/${String(model).toLowerCase()}`);
    if (prefixed) return prefixed;
  }

  const norm = normalizeId(model);
  const exact = index.byNorm.get(norm);
  if (exact?.length) return exact[0].price;

  // One candidate that starts with the same family name, e.g. a dated id for a
  // model the log names without its date. Only when it is unambiguous.
  const prefix = [...index.byNorm.entries()].filter(([key]) => key.startsWith(norm) && norm.length >= 6);
  if (prefix.length === 1) return prefix[0][1][0].price;
  return null;
}

function costOf(row, price) {
  if (!price) return null;
  const tokens = row.tokens ?? {};
  let total = 0;
  for (const key of ENTRIES) {
    const perMillion = price[key];
    if (typeof perMillion !== "number") return null;
    total += ((tokens[key] ?? 0) * perMillion) / 1_000_000;
  }
  return total;
}

function emptyTotals() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0,
    messages: 0, cost: 0, priced: true, unpricedRows: 0, rows: 0,
  };
}

function addRow(totals, row, cost) {
  const tokens = row.tokens ?? {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"]) {
    totals[key] += tokens[key] ?? 0;
  }
  totals.messages += row.messages ?? 0;
  totals.rows += 1;
  // A row with no known price does not erase the dollar figure the priced rows
  // already produced: it is counted, and the count is printed next to the
  // number. The old all-or-nothing flag printed "unpriced" for a host where 39
  // of 40 models had prices, which hid a nearly complete total.
  if (cost === null) {
    totals.priced = false;
    totals.unpricedRows = (totals.unpricedRows ?? 0) + 1;
  } else {
    totals.cost += cost;
  }
}

// `$12.34`, plus `*` when some rows in the group have no price.
function formatCost(totals) {
  const money = formatMoney(totals.cost);
  return totals.unpricedRows > 0 ? `${money}*` : money;
}

// ------------------------------------------------------------------------------
// Report - merge host snapshots and print totals
// ------------------------------------------------------------------------------

function hostSnapshots() {
  const dir = usageDir();
  if (!existsSync(dir)) return [];
  const byHost = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name === "prices.json" || name === "catalog.json") continue;
    // Syncthing leaves a conflicted copy beside the original when two machines
    // write the same name, e.g.
    // prices.sync-conflict-20261108-144922-726UY2V.json. A conflicted HOST file
    // would merge as a second copy of that host, so its rows would be counted
    // twice (the row key does not include the host). One was present in this
    // share. Skip them and say so, rather than silently keeping the stale one
    // or silently dropping the new one.
    if (name.includes(".sync-conflict-")) {
      console.warn(`usage: ignoring Syncthing conflict copy ${name}`);
      continue;
    }
    const file = path.join(dir, name);
    const data = readJson(file, null);
    if (!data || !Array.isArray(data.rows)) continue;
    // One snapshot per host IDENTITY, not per file. A host id that changes (a
    // renamed distro, a fixed suffix) leaves the previous file behind, and both
    // files then describe the same machine: `cmmhero-pc-wsl-wsl` carried 54 rows
    // identical to `cmm-pc-wsl`. Keeping the newest by collectedAt is what makes
    // the merge idempotent across a rename.
    const host = data.host ?? name.replace(/\.json$/, "");
    const previous = byHost.get(host);
    const at = Date.parse(data.collectedAt) || 0;
    if (previous && (Date.parse(previous.data.collectedAt) || 0) >= at) {
      console.warn(`usage: ${name} is an older snapshot of ${host}; using the newer file`);
      continue;
    }
    if (previous) console.warn(`usage: ${previous.name} is an older snapshot of ${host}; using ${name}`);
    byHost.set(host, { file, name, data });
  }
  // A host ID is derived from the hostname, so renaming the machine, or fixing
  // the id derivation, leaves the previous file behind under the old name. The
  // two files then describe one machine under two identities, which no key-based
  // dedup can catch: `cmmhero-pc-wsl-wsl` held 54 rows identical to
  // `cmm-pc-wsl`, and every one was counted twice. Identity by CONTENT closes
  // that: the same row set is the same machine, whatever it calls itself.
  const signature = (data) =>
    data.rows
      .map((row) => [row.day, row.session, row.harness, row.provider, row.model, row.project ?? "", row.tokens?.total ?? 0].join("|"))
      .sort()
      .join(";");
  const byContent = new Map();
  const collapsed = [];
  for (const snapshot of byHost.values()) {
    const sig = signature(snapshot.data);
    const seen = byContent.get(sig);
    if (!seen) {
      byContent.set(sig, snapshot);
      continue;
    }
    // Same rows under another id. Keep the newer collection and name the file
    // to delete, once: reporting both directions read as two broken files.
    const keepNewer = (Date.parse(snapshot.data.collectedAt) || 0) > (Date.parse(seen.data.collectedAt) || 0);
    const kept = keepNewer ? snapshot : seen;
    const dropped = keepNewer ? seen : snapshot;
    byContent.set(sig, kept);
    collapsed.push(`${dropped.name} (duplicate of ${kept.name}, ${dropped.data.rows.length} identical rows)`);
  }
  for (const note of collapsed) {
    console.warn(`usage: ignoring ${note}; delete it or let the next collect overwrite it`);
  }
  const real = [...byContent.values()];
  // Machines nobody collected still appear in atuin's synced threads (see
  // usage-atuin.mjs). Threads from a machine that does have a snapshot, captured
  // since its last collect, join that snapshot instead of listing the host twice.
  const result = [...real];
  for (const extra of atuinSnapshots(real, { localName: hostId() })) {
    const at = result.findIndex((snapshot) => snapshot.data.host === extra.data.host);
    if (at >= 0) result[at] = { ...result[at], data: { ...result[at].data, rows: [...result[at].data.rows, ...extra.data.rows] } };
    else result.push(extra);
  }
  return result;
}

// A row is one session's usage in one project on one day. The key has to match
// the app's own row identity (core/store.mjs: rowKey), which includes the
// project: a session that moves between directories legitimately produces one
// row per project, and collapsing them lost 378,545,855 tokens here because
// only the max of each field survived.
const ROW_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"];

function mergeKey(row) {
  return [row.harness, row.session, row.day, row.provider, row.model, row.project ?? ""].join("|");
}

// Dedup across hosts only for the SAME row. A session resumed on two machines
// is counted once (max), never summed. Fields are taken per row as a unit, then
// `total` is recomputed, because taking the max of each field independently
// produced rows whose `total` did not equal input+output+cacheRead+cacheWrite
// (11 such rows measured) and therefore disagreed with the app's own numbers.
function mergeRows(snapshots, { since = null } = {}) {
  const merged = new Map();
  for (const { data } of snapshots) {
    for (const row of data.rows) {
      if (since && String(row.day) < since) continue;
      const key = mergeKey(row);
      const tokens = row.tokens ?? {};
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...row,
          host: data.host,
          tokens: { ...tokens },
          messages: row.messages ?? 0,
        });
        continue;
      }
      // Same row on another host: keep the larger copy of the whole token set,
      // not the larger value of every field.
      const candidateTotal = ROW_FIELDS.reduce((sum, f) => (f === "total" ? sum : sum + (tokens[f] ?? 0)), 0);
      const existingTotal = ROW_FIELDS.reduce((sum, f) => (f === "total" ? sum : sum + (existing.tokens[f] ?? 0)), 0);
      if (candidateTotal > existingTotal) {
        existing.tokens = { ...tokens, total: candidateTotal };
      } else {
        existing.tokens.total = existingTotal;
      }
      existing.messages = Math.max(existing.messages, row.messages ?? 0);
    }
  }
  return [...merged.values()];
}

const GROUP_KEYS = {
  model: (row) => row.model || "(unknown model)",
  provider: (row) => row.provider || "(unknown provider)",
  harness: (row) => row.harness || "(unknown harness)",
  host: (row) => row.host || "(unknown host)",
  day: (row) => row.day || "(unknown day)",
  project: (row) => row.project || "(no project)",
};

// ------------------------------------------------------------------------------
// Rendering helpers
//
// Plain ANSI, no dependency. Colour is only emitted when stdout is a terminal,
// so a pipe or a redirect gets the same text with no escape codes, and NO_COLOR
// turns it off for anyone who wants that in a terminal too.
// ------------------------------------------------------------------------------

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function style(code, text) {
  return USE_COLOR ? `${code}${text}${C.reset}` : String(text);
}

function dim(text) { return style(C.dim, text); }
function bold(text) { return style(C.bold, text); }

// Exact counts with thousands separators, for totals where the digit matters.
function formatTokens(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

// Short counts for table cells: 10.82B, 236.96M, 50,850. A full 13-digit number
// in every row is unreadable and pushes the money column off the screen.
function formatCompact(value) {
  const n = Number(value ?? 0);
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

function formatMoney(value) {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

// Four decimals for the $/M tok column: a cache read costs fractions of a cent
// per million, and two decimals would print 0.00 for most of the table.
function formatUnitPrice(cost, tokens) {
  if (!tokens) return "-";
  const perMillion = (cost / tokens) * 1_000_000;
  return perMillion.toFixed(perMillion < 1 ? 3 : 2);
}

function percent(part, whole) {
  if (!whole) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

// A share bar. Blocks are unambiguous at a glance and need no colour to read,
// which is the point: the bar still works when piped.
function bar(share, width = 14) {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function pad(text, width) {
  return String(text).padEnd(width);
}

function padLeft(text, width) {
  return String(text).padStart(width);
}

// Shorten to fit without cutting a word in half where a word boundary is close.
function fit(text, width) {
  const s = String(text);
  if (s.length <= width) return s;
  return `${s.slice(0, Math.max(1, width - 1))}…`;
}

function termWidth() {
  // COLUMNS first: it is what every other CLI honours, and it is the only way
  // to ask this program what it does at a narrow width without resizing a real
  // terminal. Falls back to the tty size, then to 100.
  const fromEnv = Number(process.env.COLUMNS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.max(60, Math.min(200, fromEnv));
  const columns = Number(process.stdout.columns);
  if (!Number.isFinite(columns) || columns <= 0) return 100;
  return Math.max(60, Math.min(200, columns));
}

function rule(width, label = "") {
  if (!label) return dim("─".repeat(width));
  const head = ` ${label} `;
  const left = Math.max(0, Math.floor((width - head.length) / 2));
  const right = Math.max(0, width - head.length - left);
  return dim("─".repeat(left)) + bold(head) + dim("─".repeat(right));
}

// ------------------------------------------------------------------------------
// The report
//
// Four layers, because one flat table answered none of the questions well:
//
//   1. header    where the numbers came from and how fresh each host is
//   2. summary   one line of headline totals, tokens split by kind
//   3. detail    the requested --by table, with a share bar and $/M tok
//   4. footer    unpriced rows and how to fix them
//
// Every token kind is present in one place: input, output, cache read, cache
// write, reasoning, and the cost with its partial-pricing marker.
// ------------------------------------------------------------------------------

function buildTotals(rows, index, groupKey) {
  const groups = new Map();
  const unpriced = new Map();
  const totals = emptyTotals();

  for (const row of rows) {
    const price = priceFor(row.model, row.provider, index);
    const cost = costOf(row, price);
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, emptyTotals());
    addRow(groups.get(key), row, cost);
    addRow(totals, row, cost);
    if (cost === null) {
      const entry = unpriced.get(row.model || "(unknown)") ?? { models: new Set(), rows: 0, tokens: 0 };
      entry.models.add(`${row.provider}/${row.model}`);
      entry.rows += 1;
      entry.tokens += row.tokens?.total ?? 0;
      unpriced.set(row.model || "(unknown)", entry);
    }
  }
  return { groups, unpriced, totals };
}

function orderGroups(groups, by) {
  const byDay = by === "day";
  return [...groups.entries()].sort(
    byDay
      ? (a, b) => a[0].localeCompare(b[0])
      : (a, b) => (b[1].cost - a[1].cost) || (b[1].total - a[1].total),
  );
}

function renderHosts(snapshots, width) {
  const STALE_HOURS = 24;
  const lines = [];
  for (const { data } of snapshots) {
    const at = Date.parse(data.collectedAt);
    const age = Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 3_600_000)) : null;
    const stale = age !== null && age > STALE_HOURS;
    const ageText = age === null ? "age unknown" : `${age}h`;
    const when = String(data.collectedAt).replace("T", " ").slice(0, 16);
    const rows = data.rows.length;
    let line = `  ${pad(data.host, 20)} ${padLeft(ageText, 6)}  ${dim(`${when}  ${rows} rows`)}`;
    if (stale) line += `  ${style(C.yellow, "STALE")}`;
    lines.push(line);
  }
  return lines;
}

function renderTokenSplit(totals, width) {
  // Reasoning is NOT inside output (the collector keeps it separate), so the
  // four kinds below sum to `total` exactly. Reasoning is shown beside them as
  // its own subset of output, never added.
  const parts = [
    ["input", totals.input],
    ["output", totals.output],
    ["cache read", totals.cacheRead],
    ["cache write", totals.cacheWrite],
  ];
  const total = parts.reduce((sum, [, v]) => sum + v, 0);
  const cells = parts.map(([label, value]) => {
    const share = total ? value / total : 0;
    return `${pad(label, 12)} ${padLeft(formatCompact(value), 9)} ${dim(percent(value, total).padStart(6))} ${dim(bar(share, 10))}`;
  });
  return { cells, total };
}

async function report({ by = "model", since = null, json = false, offline = false, refresh = true } = {}) {
  if (!GROUP_KEYS[by]) throw new Error(`unknown --by '${by}' (model, provider, harness, host, day, project)`);

  if (!json && refresh && !offline) {
    const cache = loadPriceCache();
    const age = cache?.fetchedAt ? Date.now() - Date.parse(cache.fetchedAt) : Infinity;
    if (age > PRICE_TTL_MS) {
      try {
        const result = await refreshPrices();
        console.warn(dim(`prices: refreshed ${result.count} models from OpenRouter`));
      } catch (error) {
        console.warn(dim(`prices: refresh failed (${error.message}); using ${cache ? "the cached table" : "no prices"}`));
      }
    }
  }

  const snapshots = hostSnapshots();
  if (snapshots.length === 0) {
    console.log(`No host snapshots in ${usageDir()} yet.`);
    console.log("Run `usage collect` on each machine.");
    return 0;
  }

  const index = priceIndex();
  const rows = mergeRows(snapshots, { since });
  const width = termWidth();
  const { groups, unpriced, totals } = buildTotals(rows, index, GROUP_KEYS[by]);
  const ordered = orderGroups(groups, by);

  if (json) {
    console.log(JSON.stringify({
      usageDir: usageDir(),
      hosts: snapshots.map(({ data }) => ({ host: data.host, collectedAt: data.collectedAt, rows: data.rows.length })),
      by,
      since,
      groups: Object.fromEntries(ordered.map(([key, value]) => [key, value])),
      totals,
      unpriced: [...unpriced.values()].map((entry) => ({ models: [...entry.models], rows: entry.rows, tokens: entry.tokens })),
    }, null, 2));
    return 0;
  }

  // ---- 1. header -------------------------------------------------------
  const out = [];
  out.push("");
  out.push(`${bold("agent usage")} ${dim("·")} ${dim(usageDir())} ${dim("·")} ${snapshots.length} host${snapshots.length === 1 ? "" : "s"}${since ? dim(` · since ${since}`) : ""}`);
  out.push(...renderHosts(snapshots, width));
  out.push("");

  // ---- 2. headline totals ---------------------------------------------
  const { cells, total: tokenSum } = renderTokenSplit(totals, width);
  out.push(rule(width, "totals"));
  const priced = totals.unpricedRows > 0 ? `${formatMoney(totals.cost)}*` : formatMoney(totals.cost);
  out.push(
    `  ${pad("tokens", 10)}${padLeft(formatCompact(tokenSum), 9)}` +
    `   ${pad("cost", 6)}${pad(priced, 11)}` +
    `${pad("messages", 10)}${padLeft(formatTokens(totals.messages), 8)}` +
    `   ${pad("sessions", 10)}${formatTokens(totals.rows)}`,
  );
  out.push(`  ${pad("reasoning", 10)}${padLeft(formatCompact(totals.reasoning), 9)}   ${dim("subset of output, not added to the total")}`);
  out.push("");
  // Two per line keeps each bar readable without wrapping at 100 columns.
  for (let i = 0; i < cells.length; i += 2) {
    out.push(`  ${cells[i]}${cells[i + 1] ? `   ${cells[i + 1]}` : ""}`);
  }
  out.push("");

  // ---- 3. detail table -------------------------------------------------
  // One column spec drives the header, the rows and the total, so they cannot
  // drift apart the way hand-written padLeft calls did.
  //
  // Narrow terminals drop the least useful columns instead of wrapping: the
  // cache-read and share columns go first, and the name column shrinks. A
  // wrapped table is unreadable, a table with fewer columns is not.
  const narrow = width < 88;
  const compact = width < 74;
  const showShare = by !== "day" && !narrow;
  const showCache = !compact;
  const nameWidth = Math.max(14, Math.min(44, width - (showShare ? 64 : showCache ? 46 : 32),
    Math.max(...ordered.map(([k]) => k.length))));
  const COLS = [{ label: by, width: nameWidth, align: "l" }];
  COLS.push({ label: "tokens", width: 9, align: "r" });
  COLS.push({ label: "in", width: 8, align: "r" });
  COLS.push({ label: "out", width: 8, align: "r" });
  if (showCache) COLS.push({ label: "c.read", width: 9, align: "r" });
  COLS.push({ label: "msgs", width: 7, align: "r" });
  COLS.push({ label: "cost", width: 10, align: "r" });
  // "blend" not "$/M": this is cost divided by tokens ACROSS all four kinds, so
  // cache reads (a fraction of a cent per million) drag it far below the list
  // price of the model. A reader who assumes "$/M" is the model's input price
  // would read 0.004 as a leak.
  COLS.push({ label: "blended", width: 7, align: "r" });
  if (showShare) COLS.push({ label: "share", width: 18, align: "l" });

  const cell = (col, text) =>
    col.align === "r" ? padLeft(text, col.width) : pad(text, col.width);
  const formatCells = (cells) => `  ${cells.map(([col, text]) => cell(col, text)).join(" ")}`;

  const header = formatCells(COLS.map((col) => [col, col.label]));
  const lineLength = header.length;
  const barTop = Math.max(1, ...ordered.map(([, v]) => v.total));
  const money = (value) => (value.unpricedRows > 0 ? `${formatMoney(value.cost)}*` : formatMoney(value.cost));

  const rowFor = (name, value, { bold: isBold = false } = {}) => {
    const cells = [
      [COLS[0], name],
      [COLS[1], formatCompact(value.total)],
      [COLS[2], formatCompact(value.input)],
      [COLS[3], formatCompact(value.output)],
    ];
    if (showCache) cells.push([COLS[4], formatCompact(value.cacheRead)]);
    cells.push([COLS[COLS.length - (showShare ? 4 : 3)], formatTokens(value.messages)]);
    cells.push([COLS[COLS.length - (showShare ? 3 : 2)], money(value)]);
    cells.push([COLS[COLS.length - (showShare ? 2 : 1)], formatUnitPrice(value.cost, value.total)]);
    let rendered = formatCells(cells);
    if (showShare) {
      // Scaled against the largest group by TOKENS, not the total: rows are
      // ordered by cost, and with a long tail every share is under 20%.
      const shareCell = `${bar(Math.min(1, value.total / barTop), 10)} ${percent(value.total, totals.total).padStart(6)}`;
      rendered = `${rendered} ${dim(shareCell)}`;
    }
    return isBold ? bold(rendered) : rendered;
  };

  out.push(rule(width, `by ${by}`));
  out.push(dim(header));
  out.push(dim("  " + "─".repeat(lineLength - 2)));

  for (const [key, value] of ordered) {
    out.push(rowFor(fit(key, nameWidth), value));
  }

  out.push(dim("  " + "─".repeat(lineLength - 2)));
  out.push(rowFor("total", totals, { bold: true }));

  // ---- 4. footer -------------------------------------------------------
  if (unpriced.size > 0) {
    out.push("");
    out.push(rule(width, "unpriced"));
    const sorted = [...unpriced.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
    for (const [, entry] of sorted) {
      out.push(`  ${style(C.yellow, pad(formatCompact(entry.tokens), 8))} ${fit([...entry.models].join(", "), width - 20)} ${dim(`${entry.rows} row${entry.rows === 1 ? "" : "s"}`)}`);
    }
    out.push(`  ${dim(`${formatMoney(totals.cost)} covers every priced row; * marks a partial total. Fix with \`usage prices update\` or dot_config/usage/prices.json.`)}`);
  }

  out.push("");
  out.push(dim(`  blended: dollars per million tokens over all four kinds, so cheap cache reads pull it below list price.`));
  out.push(dim(`  reasoning is its own field, never added: total = input + output + cache read + cache write.`));
  out.push(dim(`  ${formatTokens(totals.rows)} rows from ${plural(snapshots.length, "host")} · exact tokens ${formatTokens(tokenSum)}`));
  out.push("");

  console.log(out.join("\n"));
  return 0;
}

// ------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------

function usage() {
  return [
    "usage - agent token and dollar totals, merged across machines",
    "",
    "  usage                     interactive on a terminal, plain report in a pipe",
    "  usage tui                 force the interactive view",
    "  usage report [options]    force the plain report",
    "      --by model|provider|harness|host|day|project",
    "      --since YYYY-MM-DD    ignore older days",
    "      --json                raw merged output",
    "      --offline             do not refresh prices",
    "  usage collect [--local-only] [--rebuild] [--stdout]",
    "                            scan this host and every other machine (WSL, ssh remotes)",
    "      --local-only          this host only",
    "      --stdout              print the snapshot instead of writing it (used by the hub)",
    "  usage sync                same as collect: refresh every machine's snapshot now",
    "  usage web [--port N] [--host H] [--no-open] [--offline]",
    "                            dashboard in the browser (default http://127.0.0.1:8787);",
    "                            opens the one already running instead of starting another",
    "  usage web install         keep the dashboard running in the background (Windows task or systemd user unit)",
    "  usage web status|start|stop|restart|uninstall",
    "  usage hosts               published snapshots and their age",
    "  usage prices update       refresh model prices from OpenRouter",
    "",
    "  tui keys: ? help   / search   1-6 range   tgmhpr group   arrows move",
    "            PgUp/PgDn page   Home/End ends   c cost   r prices   R reload   q quit",
    "            mouse: wheel scrolls, click selects, click a chip to switch",
    "  COLUMNS=n  widens or narrows the report. Below 88 the share column goes,",
    "             below 74 cache read goes too. NO_COLOR=1 disables colour.",
    "",
    `share: ${usageDir()}`,
  ].join("\n");
}

function parseArgs(argv) {
  const first = argv[0];
  const hasCommand = Boolean(first) && !first.startsWith("-");
  // No command means the interactive view when there is a terminal to draw on,
  // and the plain report when there is not: `usage > file` and `usage | grep`
  // must keep working, and a TUI in a pipe has nothing to draw with.
  const command = hasCommand ? first : process.stdout.isTTY ? "tui" : "report";
  const rest = hasCommand ? argv.slice(1) : argv;
  const sub = rest.find((arg) => !arg.startsWith("-")) ?? null;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const takesValue = ["by", "since", "port", "host"].includes(name);
    flags[name] = takesValue ? rest[++i] : true;
  }
  return { command, sub, flags };
}

async function main() {
  const { command, sub, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      console.log(usage());
      return 0;
    case "tui": {
      // Hand the terminal to the TUI. It owns the alternate screen and exits on
      // its own, so nothing here may print after it starts.
      const tui = path.join(SCRIPT_DIR, "usage-tui.mjs");
      if (!existsSync(tui)) {
        console.error(`usage: usage-tui.mjs not found next to usage.mjs (${tui})`);
        return 1;
      }
      const { spawnSync } = await import("node:child_process");
      // --frame is the headless render; pass it through so a caller does not
      // need the other file's path to get one screen of text.
      const passthrough = process.argv.includes("--frame") ? ["--frame"] : [];
      const result = spawnSync(process.execPath, [tui, ...passthrough], { stdio: "inherit" });
      return result.status ?? 0;
    }
    case "web": {
      // `usage web install|uninstall|start|stop|restart|status` manage the
      // background service (a scheduled task on Windows, a systemd user unit on
      // Linux). Plain `usage web` runs the server right here.
      const { WEB_ACTIONS, manageWeb } = await import("./usage-web-service.mjs");
      if (WEB_ACTIONS.includes(sub)) return manageWeb(sub, { scriptDir: SCRIPT_DIR, port: flags.port });
      const web = path.join(SCRIPT_DIR, "usage-web.mjs");
      if (!existsSync(web)) {
        console.error(`usage: usage-web.mjs not found next to usage.mjs (${web})`);
        return 1;
      }
      const { startWeb } = await import("./usage-web.mjs");
      const server = await startWeb({
        port: flags.port,
        host: flags.host || "127.0.0.1",
        open: !flags["no-open"],
        offline: Boolean(flags.offline),
      });
      // Already running somewhere: startWeb opened that one and there is nothing to keep alive.
      if (!server) return 0;
      // The server keeps the event loop alive; main()'s exit() must not run.
      return new Promise(() => {});
    }
    case "report":
      return report({
        by: flags.by || "model",
        since: flags.since || null,
        json: Boolean(flags.json),
        offline: Boolean(flags.offline),
      });
    case "collect":
    case "sync": // the name people reach for; same pass as collect
      collectLocal({ rebuild: Boolean(flags.rebuild), stdout: Boolean(flags.stdout) });
      if (flags.stdout) return 0;
      if (!flags["local-only"]) {
        collectWsl();
        collectRemotes();
      }
      return 0;
    case "hosts": {
      const snapshots = hostSnapshots();
      if (snapshots.length === 0) {
        console.log(`No host snapshots in ${usageDir()} yet.`);
        return 0;
      }
      for (const { file, data } of snapshots) {
        const collected = Date.parse(data.collectedAt);
        const age = Number.isFinite(collected) ? Date.now() - collected : null;
        const hours = age === null ? "?" : Math.max(0, Math.round(age / 3_600_000));
        console.log(`${data.host}  ${data.rows.length} rows  ${hours}h ago  ${file}`);
      }
      return 0;
    }
    case "prices": {
      if (sub === "update") {
        const result = await refreshPrices();
        console.log(`prices: ${result.count} models -> ${result.file}`);
        return 0;
      }
      const cache = loadPriceCache();
      if (!cache) {
        console.log("No price cache. Run `usage prices update`.");
        return 0;
      }
      console.log(`${cache.source}: ${Object.keys(cache.models).length} models, fetched ${cache.fetchedAt}`);
      return 0;
    }
    default:
      console.error(`unknown command '${command}'`);
      console.error(usage());
      return 2;
  }
}

// Export the data layer so the interactive TUI can share it instead of keeping
// a second copy of the pricing rules. Imported as a module, this file must not
// run its CLI, hence the guard at the bottom.
export {
  normalizeId,
  usageDir,
  stateDir,
  hostSnapshots,
  mergeRows,
  priceIndex,
  priceFor,
  costOf,
  emptyTotals,
  addRow,
  refreshPrices,
  loadPriceCache,
  GROUP_KEYS,
  formatCompact,
  formatMoney,
  formatTokens,
  percent,
  bar,
};

// Run the CLI only when this file is the process entrypoint. Without this an
// `import` of usage.mjs for its data layer would immediately run `usage report`
// and exit, which is exactly what the TUI must not do.
// Node reports import.meta.url as the real path but argv[1] as typed, so a
// symlinked usage.mjs (stow links the vendored files one by one) must be compared
// after realpath, or the CLI would silently do nothing.
const realPath = (file) => { try { return realpathSync(file); } catch { return path.resolve(file); } };
const invokedDirectly = process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      console.error(`usage: ${error.message}`);
      process.exit(1);
    },
  );
}
