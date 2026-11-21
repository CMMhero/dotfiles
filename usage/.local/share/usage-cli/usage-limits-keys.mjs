// ==============================================================================
// usage-limits-keys.mjs - limits and balances for providers reached with a key.
//
// Claude and Codex are plan logins with a rolling window. Everything here is the
// other kind: a key in a tool's own auth file (or the environment) that the
// provider will answer account questions for. The key is read from where the
// agents already keep it, sent only to that provider's own API over HTTPS, and
// never returned, logged or written anywhere.
//
//   openrouter   GET /api/v1/credits + /api/v1/key   credit balance, the key's own
//                                                    cap, free-model requests, spend
//   commandcode  GET /alpha/{whoami,billing/*}       the same calls `cmd /usage`
//                                                    makes: credits, 5h + weekly caps
//   deepseek     GET /user/balance                   prepaid balance
//   moonshot     GET /v1/users/me/balance            prepaid balance
//   opencode     nothing. Zen does not expose a balance to API keys, so the card
//                says where to look instead of showing a made-up number.
//
// Keys are found, in order, in: the environment, ~/.local/share/opencode/auth.json,
// ~/.pi/agent/auth.json, ~/.omp/agent/auth.json, ~/.commandcode/auth.json.
//
// Each detector returns the shape usage-limits.mjs documents, plus two optional
// extras the page understands: `window.detail` (a line under the meter, such as
// "$8.41 of $10.00") and `provider.facts` ([{ label, value }] for figures that are
// not a percentage). A detector returns null when no key for it is present.
// ==============================================================================

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (used, total) => (total > 0 ? Math.max(0, (used / total) * 100) : 0);
const title = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

// A key as one of the tools stores it: { type: "api", key } for opencode,
// { type: "api_key", key } for pi, or an OAuth entry carrying `access`.
function credentialKey(entry) {
  if (typeof entry === "string") return str(entry);
  if (!entry || typeof entry !== "object") return null;
  return str(entry.key) ?? str(entry.access) ?? str(entry.apiKey);
}

// provider id -> first key found. `aliases` lets one provider answer to the ids
// different tools use for it.
export function findKeys({ home, env }) {
  const files = [
    path.join(home, ".local", "share", "opencode", "auth.json"),
    path.join(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "auth.json"),
    path.join(home, ".omp", "agent", "auth.json"),
    path.join(home, ".commandcode", "auth.json"),
  ];
  const found = new Map();
  const put = (id, key) => { if (key && !found.has(id)) found.set(id, key); };

  put("openrouter", str(env.OPENROUTER_API_KEY));
  put("commandcode", str(env.COMMAND_CODE_API_KEY) ?? str(env.COMMANDCODE_API_KEY));
  put("deepseek", str(env.DEEPSEEK_API_KEY));
  put("moonshot", str(env.MOONSHOT_API_KEY));
  put("opencode", str(env.OPENCODE_API_KEY));

  const aliases = { "command-code": "commandcode", moonshotai: "moonshot", "moonshotai-cn": "moonshot", kimi: "moonshot" };
  for (const file of files) {
    if (!existsSync(file)) continue;
    const auth = readJson(file);
    if (!auth || typeof auth !== "object") continue;
    for (const [rawId, entry] of Object.entries(auth)) {
      const id = aliases[rawId] ?? rawId;
      put(id, credentialKey(entry));
    }
    put("commandcode", str(auth.apiKey)); // the official CLI's legacy field
  }
  return found;
}

async function getJson(fetchImpl, url, key, extraHeaders = {}) {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "usage-dashboard", ...extraHeaders },
    signal: AbortSignal.timeout(15_000),
  });
  const body = response.ok ? await response.json().catch(() => null) : null;
  return { status: response.status, ok: response.ok, body };
}

const rejected = (status) => status === 401 || status === 403;

function failure(base, status, who, fix) {
  if (rejected(status)) return { ...base, status: "expired", note: `${who} refused the key (${status}). ${fix}` };
  return { ...base, status: "error", note: `${who} answered ${status}.` };
}

const unreachable = (base, who, error) => ({ ...base, status: "error", note: `Could not reach ${who}: ${error.message}` });

// ------------------------------------------------------------------------------
// OpenRouter
// ------------------------------------------------------------------------------

export function parseOpenRouter(credits, keyInfo) {
  const windows = [];
  const facts = [];

  const total = num(credits?.data?.total_credits);
  const used = num(credits?.data?.total_usage);
  if (total !== null && used !== null && total > 0) {
    windows.push({
      id: "credits", label: "Credits", percent: pct(used, total), resetsAt: null, stale: false,
      detail: `${usd(Math.max(0, total - used))} left of ${usd(total)} · ${usd(used)} used`,
    });
  }

  const k = keyInfo?.data;
  const cap = num(k?.limit);
  if (cap !== null && cap > 0) {
    const left = num(k.limit_remaining) ?? cap - (num(k.usage) ?? 0);
    const period = str(k.limit_reset);
    windows.push({
      id: "key-limit", label: period ? `This key, ${period}` : "This key's spending cap", percent: pct(cap - left, cap),
      resetsAt: null, stale: false, detail: `${usd(Math.max(0, left))} left of ${usd(cap)}`,
    });
  }

  const free = k?.free_model_daily_requests;
  if (num(free?.limit) > 0 && num(free?.used) !== null) {
    windows.push({
      id: "free-requests", label: "Free-model requests, daily", percent: pct(free.used, free.limit), resetsAt: null,
      stale: false, detail: `${free.used} of ${free.limit} used today`,
    });
  }

  for (const [label, field] of [["Today", "usage_daily"], ["This week", "usage_weekly"], ["This month", "usage_monthly"]]) {
    const v = num(k?.[field]);
    if (v !== null) facts.push({ label, value: usd(v) });
  }
  const plan = k ? (k.is_free_tier ? "Free tier" : "Pay as you go") : null;
  return { windows, facts, plan };
}

async function openrouter(keys, fetchImpl) {
  const key = keys.get("openrouter");
  if (!key) return null;
  const base = { id: "openrouter", name: "OpenRouter", windows: [], source: "OpenRouter API", asOf: null };
  try {
    const root = "https://openrouter.ai/api/v1";
    // /credits needs no special rights on most keys, but a key without them
    // still answers /key, so one failing does not hide the other.
    const [credits, info] = await Promise.all([getJson(fetchImpl, `${root}/credits`, key), getJson(fetchImpl, `${root}/key`, key)]);
    if (rejected(info.status) && rejected(credits.status)) return failure(base, info.status, "OpenRouter", "Check the key in your tool's auth file.");
    if (!info.ok && !credits.ok) return failure(base, info.status, "OpenRouter", "");
    const parsed = parseOpenRouter(credits.body, info.body);
    return { ...base, ...parsed, status: "ok", asOf: new Date().toISOString(), note: parsed.windows.length ? null : "OpenRouter reported no balance or cap for this key." };
  } catch (error) {
    return unreachable(base, "OpenRouter", error);
  }
}

// ------------------------------------------------------------------------------
// Command Code
// ------------------------------------------------------------------------------

// resetAt arrives as epoch seconds, epoch milliseconds or an ISO string.
function commandCodeReset(value) {
  let t = null;
  if (typeof value === "number") t = value;
  else if (typeof value === "string" && value.trim()) t = /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
  if (t === null || !Number.isFinite(t) || t < 0) return null;
  return new Date(t >= 1e12 ? t : t * 1000).toISOString();
}

export function parseCommandCode(credits, subscription) {
  const windows = [];
  const facts = [];

  const labels = { fiveHour: ["5h", "5-hour session"], weekly: ["weekly", "Weekly"] };
  for (const [slot, [id, label]] of Object.entries(labels)) {
    const w = credits?.windowLimits?.[slot];
    const used = num(w?.used), cap = num(w?.cap);
    if (used === null || cap === null || cap <= 0) continue;
    windows.push({ id, label, percent: pct(used, cap), resetsAt: commandCodeReset(w.resetAt), stale: false, detail: `${usd(used)} of ${usd(cap)}` });
  }

  const c = credits?.credits;
  if (c && typeof c === "object") {
    const monthly = num(c.monthlyCredits) ?? 0, purchased = num(c.purchasedCredits) ?? 0, free = num(c.freeCredits) ?? 0;
    facts.push({ label: "Credits left", value: usd(monthly + purchased + free) });
    const parts = [["monthly", monthly], ["purchased", purchased], ["free", free]].filter(([, v]) => v > 0);
    if (parts.length > 1) facts.push({ label: "Made up of", value: parts.map(([n, v]) => `${n} ${usd(v)}`).join(" · ") });
  }

  const sub = subscription?.data;
  const planId = str(sub?.planId);
  const end = commandCodeReset(sub?.currentPeriodEnd);
  if (end) facts.push({ label: "Plan renews", value: new Date(end).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) });
  return { windows, facts, plan: planId ? title(planId.replace(/[-_]/g, " ")) : null };
}

async function commandcode(keys, fetchImpl) {
  const key = keys.get("commandcode");
  if (!key) return null;
  const base = { id: "commandcode", name: "Command Code", windows: [], source: "Command Code API", asOf: null };
  const root = "https://api.commandcode.ai";
  try {
    const who = await getJson(fetchImpl, `${root}/alpha/whoami`, key);
    if (!who.ok) return failure(base, who.status, "Command Code", "Run `cmd login` or create a new key in Command Code Studio.");
    const orgId = str(who.body?.org?.id);
    const q = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const [credits, subscription] = await Promise.all([
      getJson(fetchImpl, `${root}/alpha/billing/credits${q}`, key),
      getJson(fetchImpl, `${root}/alpha/billing/subscriptions${q}`, key),
    ]);
    const parsed = parseCommandCode(credits.body, subscription.body);
    if (!parsed.windows.length && !parsed.facts.length) return { ...base, status: "error", note: "Command Code returned no recognised usage data for this account." };
    return { ...base, ...parsed, status: "ok", asOf: new Date().toISOString(), note: null };
  } catch (error) {
    return unreachable(base, "Command Code", error);
  }
}

// ------------------------------------------------------------------------------
// DeepSeek and Moonshot: prepaid balances, no windows
// ------------------------------------------------------------------------------

const money = (currency, n) => (currency === "CNY" ? `¥${n.toFixed(2)}` : currency === "USD" ? usd(n) : `${n.toFixed(2)} ${currency}`);

export function parseDeepSeek(body) {
  const facts = [];
  for (const info of body?.balance_infos ?? []) {
    const total = Number(info.total_balance), cur = String(info.currency ?? "");
    if (!Number.isFinite(total)) continue;
    facts.push({ label: `Balance (${cur})`, value: money(cur, total) });
    const granted = Number(info.granted_balance), topped = Number(info.topped_up_balance);
    if (granted > 0 || topped > 0) facts.push({ label: "Granted · topped up", value: `${money(cur, granted || 0)} · ${money(cur, topped || 0)}` });
  }
  return { facts, available: body?.is_available !== false };
}

async function deepseek(keys, fetchImpl) {
  const key = keys.get("deepseek");
  if (!key) return null;
  const base = { id: "deepseek", name: "DeepSeek", windows: [], source: "DeepSeek API", asOf: null };
  try {
    const r = await getJson(fetchImpl, "https://api.deepseek.com/user/balance", key);
    if (!r.ok) return failure(base, r.status, "DeepSeek", "Check the key in your tool's auth file.");
    const { facts, available } = parseDeepSeek(r.body);
    return { ...base, facts, status: "ok", asOf: new Date().toISOString(), note: !facts.length ? "No balance reported." : available ? null : "DeepSeek says the balance is too low to make calls." };
  } catch (error) {
    return unreachable(base, "DeepSeek", error);
  }
}

export function parseMoonshot(body, currency) {
  const d = body?.data;
  const facts = [];
  const available = num(d?.available_balance);
  if (available !== null) facts.push({ label: "Available", value: money(currency, available) });
  const cash = num(d?.cash_balance), voucher = num(d?.voucher_balance);
  if (cash !== null && voucher !== null) facts.push({ label: "Cash · vouchers", value: `${money(currency, cash)} · ${money(currency, voucher)}` });
  return { facts };
}

async function moonshot(keys, fetchImpl) {
  const key = keys.get("moonshot");
  if (!key) return null;
  const base = { id: "moonshot", name: "Moonshot (Kimi)", windows: [], source: "Moonshot API", asOf: null };
  // Two regions, two currencies, and a key only works on the one that issued it.
  for (const [host, currency] of [["api.moonshot.ai", "USD"], ["api.moonshot.cn", "CNY"]]) {
    try {
      const r = await getJson(fetchImpl, `https://${host}/v1/users/me/balance`, key);
      if (rejected(r.status)) continue;
      if (!r.ok) return failure(base, r.status, "Moonshot", "");
      const { facts } = parseMoonshot(r.body, currency);
      return { ...base, facts, status: "ok", asOf: new Date().toISOString(), note: facts.length ? null : "No balance reported." };
    } catch (error) {
      return unreachable(base, "Moonshot", error);
    }
  }
  return failure(base, 401, "Moonshot", "Check the key in your tool's auth file.");
}

// ------------------------------------------------------------------------------
// OpenCode Zen: a key exists, a number does not
// ------------------------------------------------------------------------------

async function opencodeZen(keys) {
  if (!keys.get("opencode")) return null;
  return {
    id: "opencode", name: "OpenCode Zen", windows: [], source: "no public endpoint", asOf: null, status: "unsupported",
    note: "Zen does not expose a balance or usage to API keys; only the console shows it. Open opencode.ai/auth to see credits and spend.",
  };
}

export const keyDetectors = [
  ["openrouter", openrouter],
  ["commandcode", commandcode],
  ["opencode", opencodeZen],
  ["deepseek", deepseek],
  ["moonshot", moonshot],
];
