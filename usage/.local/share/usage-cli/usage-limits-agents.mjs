// ==============================================================================
// usage-limits-agents.mjs - limits for coding agents that keep their own login.
//
// usage-limits-keys.mjs asks a provider about a key. These are agents with an
// account of their own, found by the files they leave on disk. Each detector gets
// { home, env, fetchImpl, keys } and returns a provider in the shape
// usage-limits.mjs documents, an array of them, or null when the agent is not
// here or has nothing to show. A login or key is sent only to that agent's own
// service (or its own loopback port) and is never returned, logged or written.
//
//   cline       GET api.cline.bot /users/me + /users/{id}/balance   credit balance
//   codebuff    POST codebuff.com /api/v1/usage, GET /api/v1/freebuff/session
//               credits, and Freebuff's daily/weekly/monthly free allowance
//   9router     the local router on 127.0.0.1:20128: request totals, and each
//               connected account's own quota through its /api/usage/{id}
//   opencode    GET opencode.ai/zen/go/v1/usage (the Go plan's 5-hour, weekly and
//               monthly meters) and, from opencode's own database, how many free
//               model messages were used today and when the free limit last hit
//
// Response shapes for Cline, Codebuff and 9router come from reading those projects'
// source, not from a live account, so every parser tolerates a missing field and
// is covered by mocked responses.
// ==============================================================================

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const readText = (file) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (used, total) => (total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0);
const usd = (n) => `$${n.toFixed(2)}`;
const iso = (v) => {
  const t = typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

async function getJson(fetchImpl, url, headers = {}, init = {}) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "usage-dashboard", ...headers },
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body: body && typeof body === "object" && "data" in body && body.success ? body.data : body };
}
const rejected = (status) => status === 401 || status === 403;
const failed = (base, status, who, fix) =>
  rejected(status) ? { ...base, status: "expired", note: `${who} refused the login (${status}). ${fix}` } : { ...base, status: "error", note: `${who} answered ${status}.` };

// ------------------------------------------------------------------------------
// Cline
// ------------------------------------------------------------------------------

export function clineLogin(home, env) {
  const dir = env.CLINE_DATA_DIR || (env.CLINE_DIR ? path.join(env.CLINE_DIR, "data") : path.join(home, ".cline", "data"));
  const settings = readJson(env.CLINE_PROVIDER_SETTINGS_PATH || path.join(dir, "settings", "providers.json"));
  const auth = settings?.providers?.cline?.settings?.auth;
  if (str(auth?.accessToken)) return { token: auth.accessToken, userId: str(auth.accountId), expiresAt: iso(auth.expiresAt) };
  // The older extension keeps a JSON string under one key of secrets.json.
  const secrets = readJson(path.join(dir, "secrets.json"));
  let legacy = null;
  try { legacy = JSON.parse(secrets?.["cline:clineAccountId"] ?? "null"); } catch { /* not a login */ }
  if (str(legacy?.idToken)) return { token: legacy.idToken, userId: str(legacy.userInfo?.id), expiresAt: iso(legacy.expiresAt) };
  return null;
}

export function parseClineBalance(body) {
  const balance = num(body?.balance);
  // balance is in hundredths of a dollar, as the extension's own credit display divides it (inferred from its source).
  return balance == null ? null : { facts: [{ label: "Credits", value: usd(balance / 100) }] };
}

async function cline({ home, env, fetchImpl }) {
  const login = clineLogin(home, env);
  if (!login) return null;
  const base = { id: "cline", name: "Cline", windows: [], source: "Cline account", asOf: null };
  if (login.expiresAt && Date.parse(login.expiresAt) < Date.now()) return { ...base, status: "expired", note: "The Cline login has expired. Open Cline once and it renews itself." };
  const headers = { Authorization: `Bearer workos:${login.token.replace(/^workos:/, "")}` };
  const root = "https://api.cline.bot/api/v1";
  try {
    let userId = login.userId;
    if (!userId) {
      const me = await getJson(fetchImpl, `${root}/users/me`, headers);
      if (!me.ok) return failed(base, me.status, "Cline", "Open Cline once to sign in again.");
      userId = str(me.body?.id);
    }
    const balance = await getJson(fetchImpl, `${root}/users/${encodeURIComponent(userId)}/balance`, headers);
    if (!balance.ok) return failed(base, balance.status, "Cline", "Open Cline once to sign in again.");
    const parsed = parseClineBalance(balance.body);
    if (!parsed) return { ...base, status: "error", note: "Cline returned no balance for this account." };
    return { ...base, ...parsed, status: "ok", asOf: new Date().toISOString(), note: null };
  } catch (error) {
    return { ...base, status: "error", note: `Could not reach Cline: ${error.message}` };
  }
}

// ------------------------------------------------------------------------------
// Codebuff and Freebuff
// ------------------------------------------------------------------------------

export function codebuffToken(home, env) {
  const dir = env.FREEBUFF_CONFIG_DIR || path.join(home, ".config", "manicode");
  return str(env.CODEBUFF_API_KEY) ?? str(readJson(path.join(dir, "credentials.json"))?.default?.authToken);
}

// usage: { remainingBalance, balanceBreakdown: { free, paid }, next_quota_reset }
// session: { freebucks: { daily: { limit, spent, remaining, resetAt } }, freeWindows: { dayUsed, dayLimit, ... } }
export function parseCodebuff(usage, session) {
  const windows = [];
  const facts = [];
  const remaining = num(usage?.remainingBalance);
  if (remaining != null) facts.push({ label: "Credits left", value: Math.round(remaining).toLocaleString("en-US") });
  const free = num(usage?.balanceBreakdown?.free), paid = num(usage?.balanceBreakdown?.paid);
  if (free != null && paid != null) facts.push({ label: "Free / paid", value: `${Math.round(free).toLocaleString("en-US")} / ${Math.round(paid).toLocaleString("en-US")}` });
  if (usage?.next_quota_reset) facts.push({ label: "Quota resets", value: String(usage.next_quota_reset).slice(0, 10) });

  const daily = session?.freebucks?.daily;
  if (num(daily?.limit) > 0) {
    const spent = num(daily.spent) ?? Math.max(0, daily.limit - (num(daily.remaining) ?? daily.limit));
    windows.push({ id: "daily", label: "Daily free credits", percent: pct(spent, daily.limit), resetsAt: iso(daily.resetAt), windowMs: 86_400_000, stale: false, detail: `${Math.max(0, Math.round(daily.limit - spent)).toLocaleString("en-US")} of ${Math.round(daily.limit).toLocaleString("en-US")} left` });
  }
  const fw = session?.freeWindows;
  for (const [key, label, ms, reset] of [["day", "Free, today", 86_400_000, fw?.dayResetAt], ["week", "Free, this week", 604_800_000, null], ["month", "Free, this month", 2_592_000_000, fw?.monthResetAt]]) {
    const limit = num(fw?.[`${key}Limit`]);
    if (limit > 0 && !(key === "day" && windows.some((w) => w.id === "daily"))) {
      windows.push({ id: `free-${key}`, label, percent: pct(num(fw[`${key}Used`]) ?? 0, limit), resetsAt: iso(reset), windowMs: ms, stale: false });
    }
  }
  return { windows, facts };
}

async function codebuff({ home, env, fetchImpl }) {
  const token = codebuffToken(home, env);
  if (!token) return null;
  const base = { id: "codebuff", name: "Codebuff / Freebuff", windows: [], source: "Codebuff account", asOf: null };
  const root = env.NEXT_PUBLIC_CODEBUFF_APP_URL || "https://codebuff.com";
  try {
    const [usage, session] = await Promise.all([
      getJson(fetchImpl, `${root}/api/v1/usage`, { "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ fingerprintId: "cli-usage", authToken: token }) }),
      // A plain GET is read-only; it reports the free allowance without starting a session.
      getJson(fetchImpl, `${root}/api/v1/freebuff/session`, { Authorization: `Bearer ${token}` }),
    ]);
    if (rejected(usage.status) && rejected(session.status)) return failed(base, usage.status, "Codebuff", "Run `freebuff` or `codebuff login` to sign in again.");
    const parsed = parseCodebuff(usage.ok ? usage.body : null, session.ok ? session.body : null);
    if (!parsed.windows.length && !parsed.facts.length) return null;
    return { ...base, ...parsed, status: "ok", asOf: new Date().toISOString(), note: null };
  } catch (error) {
    return { ...base, status: "error", note: `Could not reach Codebuff: ${error.message}` };
  }
}

// ------------------------------------------------------------------------------
// 9Router
// ------------------------------------------------------------------------------

export function nineRouterDir(home, env, platform = process.platform) {
  if (env.DATA_DIR) return env.DATA_DIR;
  return platform === "win32" ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "9router") : path.join(home, ".9router");
}

// The router's own handshake for local tools: the first 16 hex characters of
// sha256(machine-id + "9r-cli-auth" + cli-secret), both read from its data folder.
export function nineRouterToken(dir) {
  const machine = readText(path.join(dir, "machine-id")), secret = readText(path.join(dir, "auth", "cli-secret"));
  return machine && secret ? createHash("sha256").update(`${machine}9r-cli-auth${secret}`).digest("hex").slice(0, 16) : null;
}

// { plan, quotas: { name: { used, total, remaining, remainingPercentage, resetAt, unlimited } } }
export function parseNineRouterQuotas(body) {
  const windows = [];
  for (const [name, q] of Object.entries(body?.quotas ?? {})) {
    if (!q || q.unlimited) continue;
    const total = num(q.total), used = num(q.used);
    const percent = total > 0 && used != null ? pct(used, total) : num(q.remainingPercentage) != null ? 100 - q.remainingPercentage : null;
    if (percent == null) continue;
    windows.push({ id: name, label: name, percent: Math.max(0, Math.min(100, percent)), resetsAt: iso(q.resetAt), stale: false });
  }
  return windows;
}

async function nineRouter({ home, env, fetchImpl }) {
  const root = (env.NINEROUTER_URL || "http://127.0.0.1:20128").replace(/\/$/, "");
  try {
    const health = await fetchImpl(`${root}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) return null;
  } catch {
    return null; // not running: nothing to show
  }
  const token = nineRouterToken(nineRouterDir(home, env));
  const headers = token ? { "x-9r-cli-token": token } : {};
  const out = [];
  try {
    const stats = await getJson(fetchImpl, `${root}/api/usage/stats?period=today`, headers);
    if (stats.ok && num(stats.body?.totalRequests) != null) {
      const tokens = (num(stats.body.totalPromptTokens) ?? 0) + (num(stats.body.totalCompletionTokens) ?? 0);
      out.push({
        id: "9router", name: "9Router", windows: [], source: "local router", status: "ok", asOf: new Date().toISOString(), note: null,
        facts: [
          { label: "Requests today", value: stats.body.totalRequests.toLocaleString("en-US") },
          { label: "Tokens today", value: tokens.toLocaleString("en-US") },
          ...(num(stats.body.totalCost) ? [{ label: "Cost today", value: usd(stats.body.totalCost) }] : []),
        ],
      });
    }
    const list = await getJson(fetchImpl, `${root}/api/providers`, headers);
    for (const c of (list.ok ? list.body?.connections ?? [] : []).slice(0, 12)) {
      if (!c?.id) continue;
      const quota = await getJson(fetchImpl, `${root}/api/usage/${encodeURIComponent(c.id)}`, headers);
      const windows = quota.ok ? parseNineRouterQuotas(quota.body) : [];
      if (!windows.length) continue; // a provider without a quota API has nothing to draw
      const label = str(c.name) ?? str(c.email) ?? str(c.provider) ?? c.id;
      out.push({ id: `9router-${c.id}`, name: `${str(c.provider) ?? "Account"} via 9Router`, plan: str(quota.body?.plan) ?? undefined, windows, source: `9Router · ${label}`, status: "ok", asOf: new Date().toISOString(), note: null });
    }
  } catch { /* what was read so far is still shown */ }
  return out.length ? out : null;
}

// ------------------------------------------------------------------------------
// OpenCode Go and the free models
// ------------------------------------------------------------------------------

const GO_WINDOWS = { rolling: ["5-hour", 5 * 3_600_000], weekly: ["Weekly", 604_800_000], monthly: ["Monthly", 2_592_000_000] };

// { usage: { rolling|weekly|monthly: { status: "ok"|"rate-limited", percent, resetsAt } } }
export function parseOpenCodeGo(body) {
  const windows = [];
  for (const [key, [label, windowMs]] of Object.entries(GO_WINDOWS)) {
    const m = body?.usage?.[key];
    if (!m || num(m.percent) == null) continue;
    windows.push({ id: key, label, percent: Math.max(0, Math.min(100, m.percent)), resetsAt: iso(m.resetsAt), windowMs, stale: false, detail: m.status === "rate-limited" ? "limit reached" : undefined });
  }
  return windows;
}

async function opencodeGo({ keys, fetchImpl }) {
  const key = keys?.get("opencode");
  if (!key) return null;
  const base = { id: "opencode-go", name: "OpenCode Go", windows: [], source: "OpenCode Go API", asOf: null };
  try {
    const res = await getJson(fetchImpl, "https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${key}` });
    // 403 "OpenCode Go subscription required" means this key has no Go plan: not an error, just nothing to show.
    if (res.status === 403) return null;
    if (!res.ok) return failed(base, res.status, "OpenCode", "Run `opencode auth login` again.");
    const windows = parseOpenCodeGo(res.body);
    return windows.length ? { ...base, windows, status: "ok", asOf: new Date().toISOString(), note: null } : null;
  } catch (error) {
    return { ...base, status: "error", note: `Could not reach OpenCode: ${error.message}` };
  }
}

// Zen's free models: a few have no "free" in the id.
export const isFreeModel = (id) => /(^|[/:-])free$|^big-pickle$|^iceman/i.test(String(id ?? ""));

// opencode records a refused free turn as an assistant message with error.type
// "provider.free-limit" (and "provider.go-limit" for the Go plan), time.completed
// and, when the gateway sent one, retryAfterMs.
export function summariseOpenCodeFree(rows, limitErrors, now = Date.now()) {
  const used = rows.filter((r) => isFreeModel(r.model)).reduce((n, r) => n + r.count, 0);
  const facts = [];
  if (used) facts.push({ label: "Free messages today", value: used.toLocaleString("en-US") });
  const last = limitErrors[0];
  if (last && now - last.at < 48 * 3_600_000) {
    facts.push({ label: "Free limit last hit", value: new Date(last.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) });
    if (last.retryAfterMs && last.at + last.retryAfterMs > now) facts.push({ label: "Resets", value: new Date(last.at + last.retryAfterMs).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) });
  }
  return facts;
}

async function opencodeFree({ home }) {
  const file = path.join(home, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(file)) return null;
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const rows = db.prepare("SELECT json_extract(data, '$.model.id') AS model, COUNT(*) AS count FROM session_message WHERE type = 'assistant' AND time_created >= ? GROUP BY model").all(dayStart);
    const limitErrors = db.prepare("SELECT json_extract(data, '$.time.completed') AS at, json_extract(data, '$.error.retryAfterMs') AS retry FROM session_message WHERE type = 'assistant' AND json_extract(data, '$.error.type') IN ('provider.free-limit', 'provider.go-limit') ORDER BY time_created DESC LIMIT 1").all()
      .map((r) => ({ at: Number(r.at), retryAfterMs: Number(r.retry) || 0 })).filter((r) => Number.isFinite(r.at));
    const facts = summariseOpenCodeFree(rows, limitErrors);
    if (!facts.length) return null;
    return {
      id: "opencode-free", name: "OpenCode free models", windows: [], facts, source: "opencode's own database", status: "ok", asOf: new Date().toISOString(),
      note: "OpenCode does not publish the daily free cap (LongCat 2.5 Free is 100 requests a day) and has no endpoint for what is left, so this counts what was used here.",
    };
  } catch {
    return null; // an older opencode with another schema, or no node:sqlite
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

export const agentDetectors = [
  ["cline", cline],
  ["codebuff", codebuff],
  ["9router", nineRouter],
  ["opencode-go", opencodeGo],
  ["opencode-free", opencodeFree],
];
