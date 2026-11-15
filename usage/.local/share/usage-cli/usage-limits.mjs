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
// Each provider answers with the same shape so the page can draw them alike:
//   { id, name, status, plan, windows: [{ id, label, percent, resetsAt, stale }],
//     asOf, source, note }
// status is one of: ok, expired, error. A provider that is not installed is left
// out of the list instead of being reported as broken.
// ==============================================================================

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function parseClaudeUsage(body) {
  const windows = [];
  // Every window is an object with a utilization and a reset time. The endpoint
  // carries a long tail of experiment keys that are null for most accounts, so
  // only the ones with a real number are shown.
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!value || typeof value !== "object" || typeof value.utilization !== "number") continue;
    if (key === "extra_usage") continue;
    const [id, label] = CLAUDE_LABELS[key] ?? [key.replace(/_/g, "-"), humanize(key)];
    windows.push({ id, label, percent: value.utilization, resetsAt: value.resets_at ?? null, stale: false });
  }
  const order = Object.values(CLAUDE_LABELS).map(([id]) => id);
  windows.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));

  const extra = body?.extra_usage;
  if (extra?.is_enabled && typeof extra.utilization === "number") {
    windows.push({ id: "extra", label: "Extra usage", percent: extra.utilization, resetsAt: null, stale: false });
  }
  return windows;
}

async function claudeLimits(home, fetchImpl) {
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
        "User-Agent": "usage-dashboard",
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
    windows.push({ id, label: minutes ? codexLabel(minutes) : humanize(slot), percent: w.used_percent, resetsAt, stale });
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

export async function detectLimits({ home = os.homedir(), fresh = false, fetchImpl = fetch } = {}) {
  const providers = [];
  const detectors = [
    ["claude", () => claudeLimits(home, fetchImpl)],
    ["codex", async () => codexLimits(home)],
  ];
  for (const [id, run] of detectors) {
    const result = await cached(id, fresh, run).catch((error) => ({
      id, name: id, status: "error", windows: [], note: error.message, asOf: null, source: "",
    }));
    if (result) providers.push(result);
  }
  return { generatedAt: new Date().toISOString(), providers, checked: detectors.map(([id]) => id) };
}
