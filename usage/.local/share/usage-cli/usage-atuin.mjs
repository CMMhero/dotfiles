// ==============================================================================
// usage-atuin.mjs - usage for machines that have no snapshot, from atuin threads.
//
// A snapshot (usage collect) scans a machine's own transcripts and is exact, but
// it only exists for machines that were collected: this PC, its WSL, the ssh
// hosts. atuin syncs captured agent threads between every machine on the account,
// and each thread carries its token totals by type, so a machine nobody collected
// still shows up there. `atuin threads list --style json` gives, per thread:
// host id, harness, model, cwd, started/updated time and
// tokens { input, output, cache_read, cache_write, reasoning }.
//
// These rows are a supplement, never a replacement:
//   - a thread whose session is already in a snapshot is skipped, so the exact
//     numbers win and nothing is counted twice;
//   - a thread is one row on the day it was last active, with one model, so a
//     thread that ran for days lands on a single day (snapshots split by day);
//   - atuin only holds what it captured, so a long-running session can read lower
//     than its transcript. The rows are labelled as coming from atuin.
// `atuin stats` is not used: it summarises shell commands, not agent tokens.
//
// Set USAGE_ATUIN=0 to leave these out.
// ==============================================================================

import { execFileSync } from "node:child_process";
import { findTool } from "./usage-env.mjs";
import { labelMachines } from "./usage-threads.mjs";

const TTL_MS = 120_000;
let cache = null;

const HARNESS = { "claude-code": "claude" };

function guessProvider(harness, model) {
  const m = String(model ?? "").toLowerCase();
  if (harness === "claude" || /claude/.test(m)) return "anthropic";
  if (harness === "codex" || /^(gpt|o\d|codex)/.test(m)) return "openai";
  if (/gemini/.test(m)) return "google";
  if (/deepseek/.test(m)) return "deepseek";
  if (m.includes("/")) return m.split("/")[0];
  return harness;
}

const localDay = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function readThreads() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value = null;
  const tool = findTool("atuin");
  if (tool) {
    try {
      const run = (args) => execFileSync(tool.cmd, args, { env: tool.env, encoding: "utf8", timeout: 30_000, maxBuffer: 512 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const threads = JSON.parse(run(["threads", "list", "--style", "json"]));
      let localHost = null;
      try { localHost = /host id:\s*(\w+)/.exec(run(["info"]))?.[1] ?? null; } catch { /* the local machine just goes unmarked */ }
      value = { threads: Array.isArray(threads) ? threads : [], localHost };
    } catch { /* atuin missing, logged out of threads, or too slow: no supplement */ }
  }
  cache = { at: Date.now(), value };
  return value;
}

// Session ids a snapshot already accounts for, with and without the "harness:" prefix.
export function knownSessions(snapshots) {
  const known = new Set();
  for (const { data } of snapshots) {
    for (const row of data.rows) {
      const id = String(row.session ?? "");
      known.add(id);
      known.add(id.slice(id.indexOf(":") + 1));
    }
  }
  return known;
}

/**
 * Pseudo snapshots, one per atuin machine, holding rows for threads no real
 * snapshot covers. localName is the snapshot name of this machine, so threads
 * from here that were captured since the last collect stay under it.
 */
export function atuinSnapshots(snapshots, { localName = null, threadsInfo = readThreads() } = {}) {
  if (!threadsInfo?.threads?.length || process.env.USAGE_ATUIN === "0") return [];
  const { threads, localHost } = threadsInfo;
  const known = knownSessions(snapshots);
  const labels = labelMachines(threads, localHost);
  const byHost = new Map();
  for (const t of threads) {
    const tokens = t.tokens ?? {};
    const input = Number(tokens.input) || 0, output = Number(tokens.output) || 0;
    const cacheRead = Number(tokens.cache_read) || 0, cacheWrite = Number(tokens.cache_write) || 0;
    const total = input + output + cacheRead + cacheWrite;
    if (!total || known.has(t.session_id)) continue;
    const day = localDay(t.updated_at ?? t.started_at);
    if (!day) continue;
    const harness = HARNESS[t.harness] ?? t.harness;
    const host = t.host === localHost && localName ? localName : `${labels.get(t.host)?.base ?? "unknown"} (atuin)`;
    const rows = byHost.get(host) ?? [];
    rows.push({
      day, session: `${harness}:${t.session_id}`, harness, provider: guessProvider(harness, t.model), model: t.model || "unknown", project: t.cwd ?? "",
      tokens: { input, output, cacheRead, cacheWrite, reasoning: Number(tokens.reasoning) || 0, total },
      messages: Number(t.message_count) || 0, activeMs: 0, longestTaskMs: 0,
    });
    byHost.set(host, rows);
  }
  const collectedAt = new Date().toISOString();
  return [...byHost.entries()].map(([host, rows]) => ({
    name: `atuin:${host}`,
    file: "atuin threads",
    data: { schema: 1, host, platform: "atuin", hostname: host, collectedAt, source: "atuin", stats: null, rows },
  }));
}
