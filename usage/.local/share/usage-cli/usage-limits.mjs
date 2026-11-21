// ==============================================================================
// usage-limits.mjs - plan limits for the coding agents found on this machine.
//
// Tokens and dollars come from transcripts; limits do not. A limit is the
// provider's own live counter ("43% of the 5-hour window, resets 11:49"), so each
// one is read from wherever that provider leaves it, and only for tools that are
// actually installed here:
//
//   claude  ~/.claude/.credentials.json holds Claude Code's OAuth token. It is sent
//           to Anthropic's own usage endpoint, the same call Claude Code's /usage
//           makes, and the answer is the live session and weekly utilisation.
//           The token is never refreshed from here: refreshing rotates the refresh
//           token, and a rotation done by a second program can log Claude Code out.
//           An expired token is reported as expired; running Claude Code once
//           renews it.
//   codex   the newest ~/.codex/sessions rollout records `rate_limits` on every
//           token_count event. Nothing is sent anywhere; the figure is as old as
//           the last Codex turn, and says so.
//
//   agy     Antigravity answers for itself: `agy -p /usage --output-format json` prints
//           the weekly quota per model group, using the login agy already holds. No
//           token is read or sent from here, and the command costs no model call.
//
//   remote  other machines are asked over ssh (see detectRemoteLimits): this file and
//           usage-limits-keys.mjs are piped to the host, run there with its own node,
//           and print the same JSON. Logins and keys never leave that machine; only
//           percentages come back.
//
//   keys    OpenRouter, Command Code, DeepSeek and Moonshot are asked for their
//           balance and caps with the key the agents already store (see
//           usage-limits-keys.mjs). OpenCode Zen has no such endpoint.
//
// Each provider answers with the same shape so the page can draw them alike:
//   { id, name, status, plan, windows: [{ id, label, percent, resetsAt, stale, windowMs,
//     detail?, share?, breakdown? }],
//     facts?: [{ label, value }], asOf, source, note }
// status is one of: ok, expired, error, unsupported. A provider that is not
// installed is left out of the list instead of being reported as broken.
// ==============================================================================

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findKeys, keyDetectors } from "./usage-limits-keys.mjs";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 60_000;
const FRESH_FLOOR_MS = 10_000; // a refresh button must not hammer the provider

const cache = new Map();

async function cached(id, fresh, produce) {
  const hit = cache.get(id);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (fresh ? age < FRESH_FLOOR_MS : age < CACHE_TTL_MS)) return hit.value;
  const value = await produce();
  cache.set(id, { at: Date.now(), value });
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------
// Claude Code
// ------------------------------------------------------------------------------

const CLAUDE_LABELS = {
  five_hour: ["session", "5-hour session"],
  seven_day: ["weekly", "Weekly, all models"],
  seven_day_opus: ["weekly-opus", "Weekly, Opus"],
  seven_day_sonnet: ["weekly-sonnet", "Weekly, Sonnet"],
  seven_day_oauth_apps: ["weekly-apps", "Weekly, connected apps"],
  seven_day_cowork: ["weekly-cowork", "Weekly, Cowork"],
};

const humanize = (key) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function claudePlan(oauth) {
  const tier = String(oauth.rateLimitTier ?? "");
  const multiplier = /(\d+)x/.exec(tier)?.[1];
  const sub = oauth.subscriptionType ? oauth.subscriptionType[0].toUpperCase() + oauth.subscriptionType.slice(1) : null;
  if (!sub) return null;
  return multiplier ? `${sub} ${multiplier}x` : sub;
}

const HOUR_MS = 3_600_000;
const WINDOW_MS = { session: 5 * HOUR_MS, weekly: 168 * HOUR_MS };
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const windowFor = (id, label, percent, resetsAt, extra = {}) => ({
  id, label, percent, resetsAt: resetsAt ?? null, stale: false,
  windowMs: id === "session" ? WINDOW_MS.session : id.startsWith("weekly") ? WINDOW_MS.weekly : null,
  ...extra,
});

export function parseClaudeUsage(body) {
  const windows = [];
  // Every window is an object with a utilization and a reset time. The endpoint
  // carries a long tail of experiment keys that are null for most accounts, so
  // only the ones with a real number are shown.
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!value || typeof value !== "object" || typeof value.utilization !== "number") continue;
    if (key === "extra_usage") continue;
    const [id, label] = CLAUDE_LABELS[key] ?? [key.replace(/_/g, "-"), humanize(key)];
    windows.push(windowFor(id, label, value.utilization, value.resets_at));
  }

  // Newer models (Fable) have no legacy seven_day_* key. They arrive in the
  // limits array as a weekly_scoped entry named after the model, and
  // weekly_scoped_shares says how much of the weekly total that model may use.
  const shares = Array.isArray(body?.weekly_scoped_shares) ? body.weekly_scoped_shares : [];
  (Array.isArray(body?.limits) ? body.limits : []).forEach((entry, index) => {
    if (entry?.kind !== "weekly_scoped" || typeof entry.percent !== "number") return;
    const name = entry.scope?.model?.display_name ?? entry.scope?.surface?.display_name;
    if (!name) return;
    const id = `weekly-${slug(name)}`;
    if (windows.some((w) => w.id === id)) return; // already reported under its legacy key
    const share = shares.find((x) => x.limit_index === index);
    windows.push(windowFor(id, `Weekly, ${name}`, entry.percent, entry.resets_at, share
      ? { share: { usedOfWeekly: share.used_percent_of_weekly, allowanceOfWeekly: share.allowance_percent_of_weekly } }
      : {}));
  });

  // Where the weekly total went (Claude Code, chats, Cowork...), attached to the
  // all-models window it explains.
  const rows = (body?.seven_day_breakdown?.rows ?? []).filter((r) => typeof r.percent === "number");
  const weekly = windows.find((w) => w.id === "weekly");
  if (weekly && rows.length) {
    weekly.breakdown = rows.map((r) => ({ label: r.display_name ?? humanize(r.key), percent: r.percent }));
    weekly.startedAt = body.seven_day_breakdown.window_started_at ?? null;
  }

  const order = Object.values(CLAUDE_LABELS).map(([id]) => id);
  const rank = (id) => order.indexOf(id) + 1 || (id.startsWith("weekly-") ? 2.5 : 99);
  windows.sort((a, b) => rank(a.id) - rank(b.id));

  const extra = body?.extra_usage;
  if (extra?.is_enabled && typeof extra.utilization === "number") {
    windows.push({ id: "extra", label: "Extra usage", percent: extra.utilization, resetsAt: null, stale: false, windowMs: null });
  }
  return windows;
}

// api.anthropic.com/api/oauth/usage answers 429 "Rate limited" to a client it does
// not know, on the first request and forever (measured: the same token with
// User-Agent "usage-dashboard" got 429 five times in a row, and 200 each time as
// "claude-code/<version>"). Claude Code's own /usage makes this exact call with its
// own token, and this is the user's own Claude Code login, so the request names the
// installed Claude Code version the way that client does.
let claudeVersion = null;
async function claudeUserAgent(home, env) {
  if (!claudeVersion) {
    claudeVersion = "2.1.0"; // any recent version is accepted; used when claude cannot be run
    try {
      const out = (await run("claude", ["--version"], { env: agentEnv(home, env), timeout: 10_000 })).toString();
      claudeVersion = /\d+\.\d+\.\d+/.exec(out)?.[0] ?? claudeVersion;
    } catch { /* keep the fallback */ }
  }
  return `claude-code/${claudeVersion}`;
}

async function claudeLimits(home, fetchImpl, env = process.env) {
  const file = path.join(home, ".claude", ".credentials.json");
  if (!existsSync(file)) return null;
  const base = { id: "claude", name: "Claude Code", windows: [], source: "Anthropic usage API", asOf: null };
  const oauth = readJson(file)?.claudeAiOauth;
  if (!oauth?.accessToken) return { ...base, status: "error", note: "No OAuth login in .credentials.json (API-key setups have no plan limits)." };
  const plan = claudePlan(oauth);

  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    return { ...base, plan, status: "expired", note: "The login token has expired. Open Claude Code once and it renews itself." };
  }
  try {
    const response = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": await claudeUserAgent(home, env),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { ...base, plan, status: "expired", note: `Anthropic refused the token (${response.status}). Open Claude Code once to sign in again.` };
    }
    if (!response.ok) return { ...base, plan, status: "error", note: `Anthropic answered ${response.status}.` };
    const windows = parseClaudeUsage(await response.json());
    return { ...base, plan, status: "ok", windows, asOf: new Date().toISOString(), note: windows.length ? null : "No limit windows reported for this plan." };
  } catch (error) {
    return { ...base, plan, status: "error", note: `Could not reach Anthropic: ${error.message}` };
  }
}

// ------------------------------------------------------------------------------
// Codex
// ------------------------------------------------------------------------------

// Newest rollout files first. Names are rollout-<ISO time>-<id>.jsonl under
// year/month/day folders, so a descending name sort is a descending time sort.
function newestRollouts(root, limit) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(full);
    }
  };
  walk(root, 0);
  return files;
}

// Last N bytes of a file. Rollouts grow to tens of megabytes and the newest
// rate-limit record is near the end.
function tail(file, bytes = 512 * 1024) {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const codexLabel = (minutes) => {
  if (minutes === 300) return "5-hour session";
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
};

export function parseCodexRateLimits(limits, recordedAt, now = Date.now()) {
  const windows = [];
  for (const [slot, id] of [["primary", "primary"], ["secondary", "secondary"]]) {
    const w = limits?.[slot];
    if (!w || typeof w.used_percent !== "number") continue;
    const minutes = w.window_minutes ?? null;
    let resetsAt = null;
    if (typeof w.resets_at === "number") resetsAt = new Date(w.resets_at * 1000).toISOString();
    else if (typeof w.resets_in_seconds === "number" && recordedAt) resetsAt = new Date(Date.parse(recordedAt) + w.resets_in_seconds * 1000).toISOString();
    // A window that reset after the record was written no longer has this
    // percentage. Keep it, marked, instead of presenting a dead number as live.
    const stale = resetsAt ? Date.parse(resetsAt) < now : false;
    windows.push({ id, label: minutes ? codexLabel(minutes) : humanize(slot), percent: w.used_percent, resetsAt, stale, windowMs: minutes ? minutes * 60_000 : null });
  }
  return windows;
}

function codexLimits(home) {
  const root = path.join(home, ".codex");
  if (!existsSync(root)) return null;
  const base = { id: "codex", name: "Codex", windows: [], source: "latest Codex session log", asOf: null };

  for (const file of newestRollouts(path.join(root, "sessions"), 25)) {
    let text;
    try {
      text = tail(file);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue; // first line of a tail is usually cut in half
      }
      const limits = record?.payload?.rate_limits ?? record?.rate_limits;
      const windows = parseCodexRateLimits(limits, record.timestamp);
      if (!windows.length) continue;
      const plan = limits.plan_type ? String(limits.plan_type)[0].toUpperCase() + String(limits.plan_type).slice(1) : null;
      const allStale = windows.every((w) => w.stale);
      return {
        ...base, plan, status: "ok", windows, asOf: record.timestamp ?? null,
        note: allStale ? "Every window has reset since the last Codex turn. Run Codex to refresh these." : "As of the last Codex turn, not live.",
      };
    }
  }
  return { ...base, status: "ok", note: "Codex is installed but no session has recorded a rate limit yet." };
}

// ------------------------------------------------------------------------------
// Antigravity
// ------------------------------------------------------------------------------

const AGY_WINDOW_MS = { daily: 86_400_000, weekly: 604_800_000, monthly: 2_592_000_000 };

// {"command":{"data":{"groups":[{"name","description","buckets":[{"id","name",
// "window","remaining_fraction","reset_time"}]}]}}} -> shared window rows.
export function parseAntigravityUsage(body) {
  const windows = [];
  for (const group of body?.command?.data?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (typeof bucket.remaining_fraction !== "number") continue;
      const window = String(bucket.window ?? "").toLowerCase();
      const models = String(group.description ?? "").replace(/^Models within this group:\s*/i, "");
      windows.push({
        id: bucket.id ?? `${group.name}-${window}`,
        label: window ? `${group.name}, ${window}` : String(group.name),
        detail: models || undefined,
        percent: Math.max(0, Math.min(100, (1 - bucket.remaining_fraction) * 100)),
        resetsAt: bucket.reset_time ?? null,
        windowMs: AGY_WINDOW_MS[window] ?? null,
        stale: false,
      });
    }
  }
  return windows;
}

// agy and claude are usually mise or vite+ shims, which a service or an ssh command
// does not have on PATH.
function agentEnv(home, env) {
  const extra = [path.join(home, ".local", "share", "mise", "shims"), path.join(home, ".local", "bin"), path.join(home, ".local", "share", "vite-plus", "bin")];
  if (env.LOCALAPPDATA) extra.push(path.join(env.LOCALAPPDATA, "mise", "shims"));
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH"; // "Path" on Windows
  return { ...env, [key]: [...extra, env[key] ?? ""].join(path.delimiter) };
}

async function findAgy(home, env) {
  const withPath = agentEnv(home, env);
  for (const name of ["agy"]) {
    try {
      await run(name, ["--version"], { env: withPath, timeout: 10_000 });
      return { cmd: name, env: withPath };
    } catch (error) {
      if (error.code !== "ENOENT") return { cmd: name, env: withPath }; // it exists, it just failed
    }
  }
  try {
    const located = (await run("mise", ["which", "agy"], { env: withPath, timeout: 10_000 })).toString().trim().split(/\r?\n/)[0];
    if (located) return { cmd: located, env: withPath };
  } catch { /* mise absent or agy not installed through it */ }
  return null;
}

async function antigravityLimits(home, env) {
  if (!existsSync(path.join(home, ".gemini", "antigravity-cli"))) return null;
  const base = { id: "antigravity", name: "Antigravity", windows: [], source: "agy /usage", asOf: null };
  const agy = await findAgy(home, env);
  if (!agy) return { ...base, status: "error", note: "Antigravity data is here but the agy command was not found on PATH." };
  try {
    const stdout = await run(agy.cmd, ["-p", "/usage", "--output-format", "json"], { env: agy.env, cwd: home, timeout: 30_000 });
    const body = JSON.parse(stdout.toString());
    const windows = parseAntigravityUsage(body);
    if (windows.length) return { ...base, status: "ok", windows, asOf: new Date().toISOString(), note: null };
    const said = String(body?.response ?? "").trim().split(/\r?\n/)[0];
    return { ...base, status: "error", note: said ? `agy said: ${said.slice(0, 200)}` : "agy reported no quota. Sign in with `agy` once." };
  } catch (error) {
    return { ...base, status: "error", note: `Could not read agy usage: ${error.message}` };
  }
}

// ------------------------------------------------------------------------------

async function detectLocalLimits({ home = os.homedir(), fresh = false, fetchImpl = fetch, env = process.env } = {}) {
  const providers = [];
  const keys = findKeys({ home, env });
  const detectors = [
    ["claude", () => claudeLimits(home, fetchImpl, env)],
    ["codex", async () => codexLimits(home)],
    ["antigravity", () => antigravityLimits(home, env)],
    ...keyDetectors.map(([id, run]) => [id, () => run(keys, fetchImpl)]),
  ];
  for (const [id, run] of detectors) {
    const result = await cached(id, fresh, run).catch((error) => ({
      id, name: id, status: "error", windows: [], note: error.message, asOf: null, source: "",
    }));
    if (result) providers.push(result);
  }
  return { generatedAt: new Date().toISOString(), host: os.hostname(), providers, checked: detectors.map(([id]) => id) };
}

// ------------------------------------------------------------------------------
// Other machines, over ssh
// ------------------------------------------------------------------------------

// The same ssh aliases usage.mjs collects from. usage.mjs is too large to import
// for one constant and is the only other place that reads this variable, so the
// default is repeated here: change both together.
export const remoteHosts = (env = process.env) =>
  (env.USAGE_REMOTE_HOSTS ?? "main,dev,it@space-pp").split(",").map((h) => h.trim()).filter(Boolean);

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REMOTE_DIR = "$HOME/.local/share/usage/limits"; // not the collector's dir: that one keeps an incremental store

// stderr from a failed ssh can be a banner, ANSI colour, or a shell's multi-line
// error with a row of ^~~~ under the bad spot. Keep the first lines that say
// something, on one line.
export function readableError(text) {
  const lines = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !/^[\^~\s]+$/.test(l));
  return lines.slice(0, 2).join(" | ").slice(0, 240);
}

function run(cmd, args, { input, timeout = 30_000, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env, cwd });
    const out = [], err = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out after ${timeout / 1000}s`)); }, timeout);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(readableError(Buffer.concat(err).toString()) || `${cmd} exited ${code}`));
    });
    child.stdin.on("error", () => {}); // ssh may close early; the exit code explains why
    child.stdin.end(input);
  });
}

async function remoteLimits(host) {
  const archive = await run("tar", ["-czf", "-", "-C", SELF_DIR, "usage-limits.mjs", "usage-limits-keys.mjs"]);
  // The login shell on these boxes is fish, which rejects `N=$(...)` and `[ ] || { }`
  // ("Unsupported use of '='"). So the work is handed to sh, quoted once for
  // whatever shell receives it. vite+ owns node here and a non-login ssh PATH
  // does not include it, so its known location is tried second.
  const work = [
    `mkdir -p ${REMOTE_DIR} && tar -xzf - -C ${REMOTE_DIR}`,
    `N=$(command -v node || ls "$HOME/.local/share/vite-plus/bin/node" 2>/dev/null)`,
    `if [ -z "$N" ]; then echo "node is not installed" >&2; exit 3; fi`,
    `"$N" ${REMOTE_DIR}/usage-limits.mjs --json`,
  ].join("; ");
  const script = `sh -c '${work}'`;
  const stdout = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR", host, script], { input: archive });
  const body = JSON.parse(stdout.toString());
  if (!Array.isArray(body?.providers)) throw new Error("answer had no providers");
  return body;
}

export async function detectRemoteLimits({ hosts = remoteHosts(), fresh = false } = {}) {
  return Promise.all(hosts.map(async (alias) => {
    const label = alias.includes("@") ? alias.split("@").pop() : alias;
    try {
      const body = await cached(`ssh:${alias}`, fresh, () => remoteLimits(alias));
      return { alias, host: body.host || label, ok: true, providers: body.providers, checked: body.checked };
    } catch (error) {
      // A machine that is off is normal. Say so on its own card instead of failing the page.
      return { alias, host: label, ok: false, providers: [], checked: [], note: `Could not reach ${label}: ${error.message}` };
    }
  }));
}

// The same account on two machines reports the same counters, so listing both is
// noise. Providers whose id, plan, status, window percentages and facts all match
// collapse into one entry that remembers which machines hold it. Reset times are
// left out of the match on purpose: an idle window's reset moves on every query
// (agy reports "a week from now"), so two machines asked seconds apart never agree.
export function providerSignature(p) {
  return JSON.stringify([
    p.id, p.plan ?? null, p.status,
    (p.windows ?? []).map((w) => [w.id, Math.round(w.percent), Boolean(w.stale)]),
    (p.facts ?? []).map((f) => [f.label, f.value]),
  ]);
}

export function uniqueProviders(hosts) {
  const seen = new Map();
  for (const h of hosts) {
    if (!h.ok) continue;
    for (const p of h.providers) {
      const key = providerSignature(p);
      const hit = seen.get(key);
      if (hit) hit.hosts.push(h.host);
      else seen.set(key, { ...p, host: undefined, hosts: [h.host] });
    }
  }
  return [...seen.values()];
}

export async function detectLimits({ remote = true, ...options } = {}) {
  const local = await detectLocalLimits(options);
  const others = remote ? await detectRemoteLimits({ fresh: options.fresh }) : [];
  // The page may run on one of the listed machines (the dashboard on main, with
  // main in USAGE_REMOTE_HOSTS). That host is already shown as local, so an ssh
  // answer carrying the same hostname is dropped instead of drawn twice.
  const hosts = [
    { alias: null, host: local.host, ok: true, local: true, providers: local.providers, checked: local.checked },
    ...others.filter((h) => !(h.ok && h.host === local.host)),
  ];
  // Flat list kept for older callers: each provider is tagged with its machine.
  const providers = hosts.flatMap((h) => h.providers.map((p) => ({ ...p, host: h.host })));
  return { generatedAt: local.generatedAt, hosts, unique: uniqueProviders(hosts), providers, checked: local.checked };
}

// `node usage-limits.mjs --json` is what a remote host runs for us.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href && process.argv.includes("--json")) {
  detectLocalLimits({ fresh: true }).then((body) => process.stdout.write(JSON.stringify(body)));
}
