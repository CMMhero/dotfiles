#!/usr/bin/env node
// ==============================================================================
// usage-web.mjs - the browser view of the usage snapshots.
//
//   usage web [--port 8787] [--host 127.0.0.1] [--no-open] [--offline]
//
// A small HTTP server on loopback: one static page (usage-web.html) and one JSON
// endpoint (/api/usage) that does the aggregation, so the page only draws.
// Same data layer as `usage report` and `usage tui`: the host snapshots in the
// usage share, merged by usage.mjs, priced by usage.mjs. Nothing is computed
// twice, so the three views cannot disagree.
//
// Ranges are counted back from the newest day in the data, not from "now", for
// the same reason the TUI does it: a host whose last snapshot is a week old would
// otherwise show an empty page.
//
// No dependency, no build step, no network call except the optional price
// refresh at start (skip it with --offline).
// ==============================================================================

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  costOf,
  hostSnapshots,
  loadPriceCache,
  mergeRows,
  priceFor,
  priceIndex,
  refreshPrices,
  usageDir,
} from "./usage.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(SCRIPT_DIR, "usage-web.html");
const DEFAULT_PORT = 8787;
const PRICE_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 5_000;

const RANGES = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365, all: null };

// ------------------------------------------------------------------------------
// Data
// ------------------------------------------------------------------------------

// hostSnapshots() reports Syncthing conflicts and renamed hosts with console.warn.
// A server has no terminal worth interrupting, so the warnings ride along in the
// JSON and the page shows them instead.
let snapshotCache = null;
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

function addDays(day, delta) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function dayRange(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

const zero = () => ({
  tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  messages: 0, cost: 0, unpricedTokens: 0, unpricedRows: 0, sessions: new Set(),
});

function add(target, row, cost) {
  const t = row.tokens ?? {};
  target.input += t.input ?? 0;
  target.output += t.output ?? 0;
  target.cacheRead += t.cacheRead ?? 0;
  target.cacheWrite += t.cacheWrite ?? 0;
  target.reasoning += t.reasoning ?? 0;
  target.tokens += t.total ?? 0;
  target.messages += row.messages ?? 0;
  target.sessions.add(row.session);
  if (cost === null) {
    target.unpricedRows += 1;
    target.unpricedTokens += t.total ?? 0;
  } else {
    target.cost += cost;
  }
}

const plain = ({ sessions, ...rest }) => ({ ...rest, sessions: sessions.size });

function bucket(map, key, row, cost, extra) {
  let entry = map.get(key);
  if (!entry) {
    entry = { ...zero(), ...extra };
    map.set(key, entry);
  }
  add(entry, row, cost);
}

// Dollars per kind, and what the cache saved against paying the input rate for
// every cached token. Null price = unknown, so those rows add nothing here and
// are counted as unpriced instead of as free.
function priceBreakdown(row, price) {
  const t = row.tokens ?? {};
  const per = (kind) => ((t[kind] ?? 0) * (price[kind] ?? 0)) / 1e6;
  return {
    input: per("input"),
    output: per("output"),
    cacheRead: per("cacheRead"),
    cacheWrite: per("cacheWrite"),
    saved: ((t.cacheRead ?? 0) * Math.max(0, (price.input ?? 0) - (price.cacheRead ?? 0))) / 1e6,
  };
}

function summarize({ range = "30d", host = "all", harness = "all" } = {}) {
  if (!(range in RANGES)) range = "30d";
  const { snapshots, rows: merged, warnings } = loadSnapshots();
  const index = prices();

  const hosts = [...new Set(merged.map((row) => row.host).filter(Boolean))].sort();
  const harnesses = [...new Set(merged.map((row) => row.harness).filter(Boolean))].sort();
  const filtered = merged.filter(
    (row) => (host === "all" || row.host === host) && (harness === "all" || row.harness === harness),
  );

  const allDays = merged.map((row) => String(row.day)).sort();
  const newestDay = allDays.at(-1) ?? new Date().toISOString().slice(0, 10);
  const oldestDay = allDays[0] ?? newestDay;
  const span = RANGES[range];
  const cutoff = span ? addDays(newestDay, -(span - 1)) : oldestDay;

  const totals = zero();
  const costByType = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cacheSavings = 0;
  let activeMs = 0;
  const byHarness = new Map();
  const byModel = new Map();
  const byDay = new Map();
  const byProject = new Map();
  const byHost = new Map();
  const dailyByHarness = new Map(); // harness -> day -> {tokens, cost}
  const heat = new Map();
  const heatFrom = addDays(newestDay, -370);

  for (const row of filtered) {
    const day = String(row.day);
    const price = priceFor(row.model, row.provider, index);
    const cost = costOf(row, price);

    // The heatmap ignores the range chips on purpose: it is the year at a glance.
    if (day >= heatFrom) {
      const cell = heat.get(day) ?? { tokens: 0, cost: 0, messages: 0 };
      cell.tokens += row.tokens?.total ?? 0;
      cell.cost += cost ?? 0;
      cell.messages += row.messages ?? 0;
      heat.set(day, cell);
    }

    if (day < cutoff) continue;
    add(totals, row, cost);
    activeMs += row.activeMs ?? 0;
    if (price && cost !== null) {
      const parts = priceBreakdown(row, price);
      for (const kind of Object.keys(costByType)) costByType[kind] += parts[kind];
      cacheSavings += parts.saved;
    }

    bucket(byHarness, row.harness || "unknown", row, cost);
    bucket(byModel, `${row.harness}|${row.provider}|${row.model}`, row, cost, {
      model: row.model || "(unknown)", harness: row.harness || "unknown", provider: row.provider || "",
    });
    bucket(byDay, day, row, cost);
    bucket(byProject, row.project || "(no project)", row, cost);
    bucket(byHost, row.host || "unknown", row, cost);

    const series = dailyByHarness.get(row.harness || "unknown") ?? new Map();
    const slot = series.get(day) ?? { tokens: 0, cost: 0 };
    slot.tokens += row.tokens?.total ?? 0;
    slot.cost += cost ?? 0;
    series.set(day, slot);
    dailyByHarness.set(row.harness || "unknown", series);
  }

  const days = dayRange(cutoff, newestDay);
  const harnessOrder = [...byHarness.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([name]) => name);
  const list = (map, name) =>
    [...map.entries()].map(([key, value]) => ({ [name]: key, ...plain(value) }));

  return {
    meta: {
      usageDir: usageDir(),
      generatedAt: new Date().toISOString(),
      priceFetchedAt: loadPriceCache()?.fetchedAt ?? null,
      range, host, harness, cutoff, newestDay, oldestDay,
      warnings,
    },
    filters: { hosts, harnesses },
    hosts: snapshots.map(({ data }) => ({
      host: data.host, collectedAt: data.collectedAt, rows: data.rows.length, platform: data.platform ?? null,
    })),
    totals: { ...plain(totals), cacheSavings, activeMs, costByType },
    harnesses: harnessOrder.map((name) => ({ harness: name, ...plain(byHarness.get(name)) })),
    daily: {
      days,
      series: harnessOrder.map((name) => ({
        harness: name,
        tokens: days.map((day) => dailyByHarness.get(name)?.get(day)?.tokens ?? 0),
        cost: days.map((day) => dailyByHarness.get(name)?.get(day)?.cost ?? 0),
      })),
    },
    models: list(byModel, "key").map(({ key, ...rest }) => rest),
    byDay: list(byDay, "day").sort((a, b) => b.day.localeCompare(a.day)),
    byProject: list(byProject, "project"),
    byHost: list(byHost, "host"),
    heatmap: { from: heatFrom, to: newestDay, days: Object.fromEntries(heat) },
  };
}

// ------------------------------------------------------------------------------
// Server
// ------------------------------------------------------------------------------

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function allowedHost(header, bound) {
  // A page on another origin could otherwise reach a loopback server through DNS
  // rebinding. The Host header is the one thing it cannot fake to a trusted name.
  if (!header) return false;
  const name = header.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(name)) return true;
  return bound !== "127.0.0.1" && bound !== "localhost" && bound !== "::1";
}

function createServer(bound) {
  return http.createServer((req, res) => {
    if (!allowedHost(req.headers.host, bound)) return send(res, 403, "text/plain", "forbidden host");
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return send(res, 200, "text/html; charset=utf-8", readFileSync(PAGE));
      }
      if (url.pathname === "/api/usage") {
        const q = url.searchParams;
        if (q.get("fresh")) snapshotCache = null;
        const body = summarize({ range: q.get("range") ?? "30d", host: q.get("host") ?? "all", harness: q.get("harness") ?? "all" });
        return send(res, 200, "application/json", JSON.stringify(body));
      }
      return send(res, 404, "text/plain", "not found");
    } catch (error) {
      return send(res, 500, "application/json", JSON.stringify({ error: error.message }));
    }
  });
}

function listen(server, host, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === "EADDRINUSE" && attempts > 0) {
        server.off("error", onError);
        listen(server, host, port + 1, attempts - 1).then(resolve, reject);
      } else {
        reject(error);
      }
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address().port);
    });
  });
}

// Best effort and silent: a headless box (SSH, a VPS) has nothing to open, and the
// URL is printed either way.
function openBrowser(url) {
  const wsl = process.platform === "linux" && (process.env.WSL_DISTRO_NAME || /microsoft/i.test(safeRead("/proc/version")));
  let command;
  let args;
  if (process.platform === "win32") [command, args] = ["cmd.exe", ["/c", "start", "", url]];
  else if (process.platform === "darwin") [command, args] = ["open", [url]];
  else if (wsl) [command, args] = ["explorer.exe", [url]];
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) [command, args] = ["xdg-open", [url]];
  else return false;
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function startWeb({ port = DEFAULT_PORT, host = "127.0.0.1", open = true, offline = false } = {}) {
  if (!offline) {
    const age = Date.now() - (Date.parse(loadPriceCache()?.fetchedAt) || 0);
    if (age > PRICE_TTL_MS) {
      // Background: the page must not wait on OpenRouter. The next /api/usage
      // after it lands picks the new table up (the price index caches for 60 s).
      refreshPrices().then(
        (result) => console.log(`prices: refreshed ${result.count} models`),
        (error) => console.log(`prices: refresh failed (${error.message}); using the cached table`),
      );
    }
  }

  const server = createServer(host);
  const actual = await listen(server, host, Number(port) || DEFAULT_PORT);
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const url = `http://${shown}:${actual}/`;
  console.log(`usage web: ${url}`);
  console.log(`  data: ${usageDir()}   (ctrl+c to stop)`);
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.log("  note: listening beyond loopback; anyone who can reach this port sees your usage");
  }
  if (open) openBrowser(url);
  return server;
}

export { summarize, startWeb };
