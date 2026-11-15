// ==============================================================================
// usage-summary.mjs - everything the dashboard page shows, computed from the
// merged host snapshots in one pass per request.
//
// One call answers one filter state: a date window, host / agent / project / model
// filters, a free-text search, and which dimension the day chart is stacked by.
// The same call computes the window just before it, so every headline number
// carries its change against the previous period.
//
// Pricing and merging are usage.mjs's, so this page, `usage report` and
// `usage tui` agree to the cent. A row with no price adds nothing to a dollar
// figure and is counted as unpriced; it is never treated as free.
// ==============================================================================

import {
  costOf,
  hostSnapshots,
  loadPriceCache,
  mergeRows,
  priceFor,
  priceIndex,
  usageDir,
} from "./usage.mjs";

const SNAPSHOT_TTL_MS = 5_000;
const HEAT_DAYS = 371;
const TOP_SERIES = 7;
const TABLE_LIMIT = 500;

const RANGE_DAYS = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
const GROUPS = {
  project: (row) => row.project || "(no project)",
  agent: (row) => row.harness || "unknown",
  model: (row) => row.model || "(unknown model)",
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------------------
// Inputs
// ------------------------------------------------------------------------------

// hostSnapshots() reports Syncthing conflicts and renamed hosts with console.warn.
// A server has no terminal worth interrupting, so the warnings ride along in the
// JSON and the page shows them.
let snapshotCache = null;
export function resetSnapshots() {
  snapshotCache = null;
}

function loadSnapshots() {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache;
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" ").replace(/^usage: /, ""));
  try {
    const snapshots = hostSnapshots();
    snapshotCache = { at: now, snapshots, rows: mergeRows(snapshots), warnings };
  } finally {
    console.warn = original;
  }
  return snapshotCache;
}

let indexCache = null;
function prices() {
  const now = Date.now();
  if (!indexCache || now - indexCache.at > 60_000) indexCache = { at: now, index: priceIndex() };
  return indexCache.index;
}

const addDays = (day, delta) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
function dayRange(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

// ------------------------------------------------------------------------------
// Accumulators
// ------------------------------------------------------------------------------

const zero = () => ({
  tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  messages: 0, cost: 0, unpricedRows: 0, unpricedTokens: 0, activeMs: 0, sessions: new Set(),
});

function add(target, row) {
  const t = row.tokens ?? {};
  target.input += t.input ?? 0;
  target.output += t.output ?? 0;
  target.cacheRead += t.cacheRead ?? 0;
  target.cacheWrite += t.cacheWrite ?? 0;
  target.reasoning += t.reasoning ?? 0;
  target.tokens += t.total ?? 0;
  target.messages += row.messages ?? 0;
  target.activeMs += row.activeMs ?? 0;
  target.sessions.add(row.session);
  if (row._cost === null) {
    target.unpricedRows += 1;
    target.unpricedTokens += t.total ?? 0;
  } else {
    target.cost += row._cost;
  }
}

const plain = ({ sessions, ...rest }) => ({ ...rest, sessions: sessions.size });

function bucket(map, key, row, extra) {
  let entry = map.get(key);
  if (!entry) {
    entry = { ...zero(), ...(extra ?? {}) };
    map.set(key, entry);
  }
  add(entry, row);
  return entry;
}

// Dollars per kind, and what the cache saved against paying the input rate for
// every cached token.
function priceParts(row, price) {
  const t = row.tokens ?? {};
  const per = (kind) => ((t[kind] ?? 0) * (price[kind] ?? 0)) / 1e6;
  return {
    input: per("input"), output: per("output"), cacheRead: per("cacheRead"), cacheWrite: per("cacheWrite"),
    saved: ((t.cacheRead ?? 0) * Math.max(0, (price.input ?? 0) - (price.cacheRead ?? 0))) / 1e6,
  };
}

// Share of prompt tokens served from cache. The prompt is everything the model
// read: uncached input, cache reads and cache writes.
const hitRate = (t) => {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return prompt ? t.cacheRead / prompt : 0;
};

function headline(acc, parts) {
  const sessions = acc.sessions.size;
  return {
    ...plain(acc),
    costByType: parts.byType,
    cacheSavings: parts.saved,
    cacheHitRate: hitRate(acc),
    outputPerInput: acc.input ? acc.output / acc.input : null,
    tokensPerSession: sessions ? acc.tokens / sessions : null,
    costPerSession: sessions ? acc.cost / sessions : null,
    costPerMessage: acc.messages ? acc.cost / acc.messages : null,
    costPer1kOutput: acc.output ? (acc.cost / acc.output) * 1000 : null,
  };
}

// ------------------------------------------------------------------------------
// The summary
// ------------------------------------------------------------------------------

const bareSession = (id) => String(id).replace(/^[a-z]+:/, "");

export function summarize(options = {}, { threadsBySession = null } = {}) {
  const {
    range = "30d", from = null, to = null,
    host = "all", harness = "all", project = "all", model = "all",
    q = "", group = "project",
  } = options;

  const { snapshots, rows: merged, warnings } = loadSnapshots();
  const index = prices();
  const groupKey = GROUPS[group] ?? GROUPS.project;

  // Price every row once; both windows and every table reuse the result.
  const priceCache = new Map();
  for (const row of merged) {
    const key = `${row.provider}|${row.model}`;
    if (!priceCache.has(key)) priceCache.set(key, priceFor(row.model, row.provider, index));
    const price = priceCache.get(key);
    row._cost = costOf(row, price);
    row._parts = price && row._cost !== null ? priceParts(row, price) : null;
  }

  // Options for the filter menus come from every row, not the filtered set, so
  // picking one agent does not empty the other menus.
  const options_ = {
    hosts: [...new Set(merged.map((r) => r.host).filter(Boolean))].sort(),
    agents: [...new Set(merged.map((r) => r.harness).filter(Boolean))].sort(),
    projects: [...new Set(merged.map((r) => r.project).filter(Boolean))].sort(),
    models: [...new Set(merged.map((r) => r.model).filter(Boolean))].sort(),
  };

  const needle = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (row) => {
    if (host !== "all" && row.host !== host) return false;
    if (harness !== "all" && row.harness !== harness) return false;
    if (project !== "all" && (row.project || "(no project)") !== project) return false;
    if (model !== "all" && row.model !== model) return false;
    if (!needle.length) return true;
    const title = threadsBySession?.get(bareSession(row.session))?.title ?? "";
    const hay = `${row.model} ${row.provider} ${row.harness} ${row.project} ${row.session} ${title}`.toLowerCase();
    return needle.every((word) => hay.includes(word));
  };
  const filtered = merged.filter(matches);

  // Windows count back from the newest day in the data, not from today, so a host
  // whose last snapshot is old still shows something.
  const allDays = merged.map((r) => String(r.day)).sort();
  const newestDay = allDays.at(-1) ?? new Date().toISOString().slice(0, 10);
  const oldestDay = allDays[0] ?? newestDay;

  let start;
  let end = newestDay;
  let label = range;
  if (range === "custom" && DAY.test(from ?? "") && DAY.test(to ?? "") && from <= to) {
    start = from;
    end = to;
  } else if (range === "all") {
    start = oldestDay;
  } else {
    start = addDays(newestDay, -((RANGE_DAYS[range] ?? 30) - 1));
    if (!(range in RANGE_DAYS)) label = "30d";
  }
  const span = daysBetween(start, end);
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(start, -span);
  const hasPrevious = range !== "all";

  const days = dayRange(start, end);
  const current = zero();
  const previous = zero();
  const curParts = { saved: 0, byType: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const prevParts = { saved: 0, byType: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

  const bySession = new Map();
  const byProject = new Map();
  const byAgent = new Map();
  const byModel = new Map();
  const byDay = new Map();
  const dayAcc = new Map(); // day -> accumulator, for the tile sparklines
  const stacks = new Map(); // group key -> day -> {tokens,cost,messages}
  const heat = new Map();
  const heatFrom = addDays(newestDay, -(HEAT_DAYS - 1));

  for (const row of filtered) {
    const day = String(row.day);

    if (day >= heatFrom && day <= newestDay) {
      const cell = heat.get(day) ?? { tokens: 0, cost: 0, messages: 0 };
      cell.tokens += row.tokens?.total ?? 0;
      cell.cost += row._cost ?? 0;
      cell.messages += row.messages ?? 0;
      heat.set(day, cell);
    }

    if (hasPrevious && day >= prevStart && day <= prevEnd) {
      add(previous, row);
      if (row._parts) {
        prevParts.saved += row._parts.saved;
        for (const kind of Object.keys(prevParts.byType)) prevParts.byType[kind] += row._parts[kind];
      }
    }

    if (day < start || day > end) continue;
    add(current, row);
    if (row._parts) {
      curParts.saved += row._parts.saved;
      for (const kind of Object.keys(curParts.byType)) curParts.byType[kind] += row._parts[kind];
    }

    const sid = bareSession(row.session);
    const entry = bucket(bySession, row.session, row, { session: row.session, harness: row.harness, project: row.project || "(no project)", lastDay: day, models: new Map() });
    if (day > entry.lastDay) entry.lastDay = day;
    entry.models.set(row.model, (entry.models.get(row.model) ?? 0) + (row.tokens?.total ?? 0));
    if (threadsBySession?.has(sid)) entry.thread = threadsBySession.get(sid);

    bucket(byProject, row.project || "(no project)", row);
    bucket(byAgent, row.harness || "unknown", row);
    bucket(byModel, `${row.harness}|${row.model}`, row, { model: row.model || "(unknown)", agent: row.harness || "unknown", provider: row.provider || "" });
    bucket(byDay, day, row);
    bucket(dayAcc, day, row);

    const key = groupKey(row);
    const series = stacks.get(key) ?? new Map();
    const slot = series.get(day) ?? { tokens: 0, cost: 0, messages: 0 };
    slot.tokens += row.tokens?.total ?? 0;
    slot.cost += row._cost ?? 0;
    slot.messages += row.messages ?? 0;
    series.set(day, slot);
    stacks.set(key, series);
  }

  // Stack: the biggest few keys by tokens, everything else folded into "Other".
  const ranked = [...stacks.entries()]
    .map(([key, byDayMap]) => [key, [...byDayMap.values()].reduce((s, v) => s + v.tokens, 0), byDayMap])
    .sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, TOP_SERIES);
  const rest = ranked.slice(TOP_SERIES);
  const asSeries = (key, maps) => ({
    key,
    tokens: days.map((d) => maps.reduce((s, m) => s + (m.get(d)?.tokens ?? 0), 0)),
    cost: days.map((d) => maps.reduce((s, m) => s + (m.get(d)?.cost ?? 0), 0)),
    messages: days.map((d) => maps.reduce((s, m) => s + (m.get(d)?.messages ?? 0), 0)),
  });
  const series = top.map(([key, , m]) => asSeries(key, [m]));
  if (rest.length) series.push({ ...asSeries("Other", rest.map((r) => r[2])), other: rest.length });

  const spark = (pick) => days.map((d) => (dayAcc.has(d) ? pick(dayAcc.get(d)) : 0));
  const sparks = {
    tokens: spark((a) => a.tokens),
    cost: spark((a) => a.cost),
    sessions: spark((a) => a.sessions.size),
    messages: spark((a) => a.messages),
    cacheHitRate: spark(hitRate),
  };

  const list = (map, shape) => [...map.entries()].map(([key, value]) => shape(key, plain(value), value));
  const byTokens = (a, b) => b.tokens - a.tokens;

  const sessions = list(bySession, (key, { models: _models, thread: _thread, ...v }, raw) => ({
    ...v,
    session: raw.session,
    agent: raw.harness,
    project: raw.project,
    lastDay: raw.lastDay,
    model: [...raw.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
    modelCount: raw.models.size,
    thread: raw.thread ? { id: raw.thread.id, title: raw.thread.title } : null,
  })).sort((a, b) => b.lastDay.localeCompare(a.lastDay) || byTokens(a, b));

  return {
    meta: {
      usageDir: usageDir(),
      generatedAt: new Date().toISOString(),
      priceFetchedAt: loadPriceCache()?.fetchedAt ?? null,
      range: label, start, end, span, newestDay, oldestDay,
      previous: hasPrevious ? { start: prevStart, end: prevEnd } : null,
      group: GROUPS[group] ? group : "project",
      warnings,
    },
    options: options_,
    hosts: snapshots.map(({ data }) => ({ host: data.host, collectedAt: data.collectedAt, rows: data.rows.length, platform: data.platform ?? null })),
    totals: headline(current, curParts),
    previous: hasPrevious ? headline(previous, prevParts) : null,
    sparks,
    days,
    stack: series,
    sessions: sessions.slice(0, TABLE_LIMIT),
    sessionCount: sessions.length,
    projects: list(byProject, (key, v) => ({ project: key, ...v })).sort(byTokens),
    agents: list(byAgent, (key, v) => ({ agent: key, ...v })).sort(byTokens),
    models: list(byModel, (key, v, raw) => ({ model: raw.model, agent: raw.agent, provider: raw.provider, ...v })).sort(byTokens),
    byDay: list(byDay, (key, v) => ({ day: key, ...v })).sort((a, b) => b.day.localeCompare(a.day)),
    heatmap: { from: heatFrom, to: newestDay, days: Object.fromEntries(heat) },
  };
}
