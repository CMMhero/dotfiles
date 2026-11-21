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
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectBilling } from "./usage-billing.mjs";
import { detectLimits } from "./usage-limits.mjs";
import { listThreads, resumeCommands, openThreadFolder, revealFile, sessionIndex, showThread, threadFile, threadImage, threadRepo } from "./usage-threads.mjs";
import { loadPriceCache, refreshPrices, usageDir } from "./usage.mjs";
import { ensureIcons, listIcons, readIcon } from "./usage-icons.mjs";
import { usdRates } from "./usage-rates.mjs";
import { installedPort } from "./usage-web-service.mjs";
import { catalogIsStale, modelsReport, refreshCatalog } from "./usage-models.mjs";
import { resetSnapshots, summarize } from "./usage-summary.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(SCRIPT_DIR, "usage-web.html");
const ASSETS = path.join(SCRIPT_DIR, "usage-web-assets");
const MIME = { ".woff2": "font/woff2", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".png": "image/png" };
const DEFAULT_PORT = 8787;
const PRICE_TTL_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------------------
// Server
// ------------------------------------------------------------------------------

let runOffline = false;

// Text answers are compressed and carry an ETag, so a poll that finds nothing new costs a
// few bytes (a 304) instead of a few hundred kilobytes, and what is sent is smaller on the
// wire. The page itself is compressed once and kept, since it is the same bytes every time.
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
const packed = new Map(); // etag -> { gzip, br }
function send(res, status, type, body, cache = "no-store") {
  const req = res.req;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
  const headers = { "Content-Type": type, "Cache-Control": cache };
  if (status !== 200 || !COMPRESSIBLE.test(type) || buf.length < 1024 || !req) {
    res.writeHead(status, headers);
    return res.end(buf);
  }
  // Answers that were never to be stored are revalidated instead: same freshness, cheaper when unchanged.
  if (cache === "no-store") headers["Cache-Control"] = "no-cache";
  // The time an answer was made is not part of what it says, or no two answers would ever match.
  const tagged = type.startsWith("application/json") ? Buffer.from(buf.toString().replace(/"generatedAt":"[^"]*"/, "")) : buf;
  const etag = `"${createHash("sha1").update(tagged).digest("base64url").slice(0, 22)}"`;
  headers.ETag = etag; headers.Vary = "Accept-Encoding";
  const seen = String(req.headers["if-none-match"] ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (seen.includes(etag) || seen.includes("*")) { res.writeHead(304, headers); return res.end(); }
  // gzip;q=0 means "not gzip".
  const accept = String(req.headers["accept-encoding"] ?? "").split(",").filter((t) => !/;\s*q=0(\.0*)?\s*$/.test(t)).join(",");
  let entry = packed.get(etag);
  if (!entry) { entry = {}; packed.set(etag, entry); if (packed.size > 40) packed.delete(packed.keys().next().value); }
  if (/\bbr\b/.test(accept) && type.startsWith("text/html")) {
    entry.br ??= brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
    headers["Content-Encoding"] = "br"; res.writeHead(200, headers); return res.end(entry.br);
  }
  if (/\bgzip\b/.test(accept)) {
    entry.gzip ??= gzipSync(buf, { level: 5 });
    headers["Content-Encoding"] = "gzip"; res.writeHead(200, headers); return res.end(entry.gzip);
  }
  res.writeHead(200, headers);
  return res.end(buf);
}

// Static files under usage-web-assets only. The resolved path has to stay inside
// the folder, so `/assets/../../.ssh/config` cannot walk out of it.
function serveAsset(res, pathname) {
  // Icons not in the bundle may be in the download cache (usage-icons.mjs).
  const icon = /^\/assets\/icons\/([a-z0-9-]{1,40})\.svg$/.exec(pathname);
  if (icon) {
    const file = readIcon(icon[1]);
    return file ? send(res, 200, "image/svg+xml", file, "public, max-age=86400") : send(res, 404, "text/plain", "not found");
  }
  let name;
  try { name = decodeURIComponent(pathname.slice("/assets/".length)); } catch { return send(res, 404, "text/plain", "not found"); }
  const target = path.resolve(ASSETS, name);
  const type = MIME[path.extname(target).toLowerCase()];
  if (!target.startsWith(ASSETS + path.sep) || !type) return send(res, 404, "text/plain", "not found");
  try {
    if (!statSync(target).isFile()) throw new Error("not a file");
    return send(res, 200, type, readFileSync(target), "public, max-age=86400");
  } catch {
    return send(res, 404, "text/plain", "not found");
  }
}

function allowedHost(header, bound) {
  // A page on another origin could otherwise reach a loopback server through DNS
  // rebinding. The Host header is the one thing it cannot fake to a trusted name.
  if (!header) return false;
  const name = header.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(name)) return true;
  return bound !== "127.0.0.1" && bound !== "localhost" && bound !== "::1";
}


// ---- live updates ----------------------------------------------------------------------
// The page keeps one EventSource open. While at least one is connected the server watches the
// snapshot folder and the thread list and sends a one-word event when either changed, so the
// page reloads that one thing at once instead of waiting for its next timer tick.
const clients = new Set();
let watchTimer = null, lastUsage = "", lastThreads = "";
function usageFingerprint() {
  try {
    const dir = usageDir();
    return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => { const st = statSync(path.join(dir, n)); return `${n}:${st.size}:${Math.round(st.mtimeMs)}`; }).sort().join("|");
  } catch { return ""; }
}
function broadcast(name) { for (const res of clients) res.write(`event: ${name}\ndata: ${Date.now()}\n\n`); }
async function watchTick(n) {
  const usage = usageFingerprint();
  if (usage !== lastUsage) { if (lastUsage) { resetSnapshots(); broadcast("usage"); } lastUsage = usage; }
  if (n % 4 === 0) { // every ~8 seconds: the thread list is an external command, so not too often
    try {
      const { threadsSignature } = await import("./usage-threads.mjs");
      const sig = await threadsSignature();
      if (sig !== lastThreads) { if (lastThreads) broadcast("threads"); lastThreads = sig; }
    } catch { /* atuin missing: nothing to watch */ }
  }
  if (n % 30 === 0) broadcast("limits"); // limits move slowly and cost calls, so once a minute
}
function serveEvents(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n");
  clients.add(res);
  if (!watchTimer) { let n = 0; watchTimer = setInterval(() => { watchTick(n += 1).catch(() => {}); }, 2000); watchTimer.unref?.(); }
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping); clients.delete(res);
    if (!clients.size && watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  });
}

function createServer(bound) {
  return http.createServer((req, res) => {
    if (!allowedHost(req.headers.host, bound)) return send(res, 403, "text/plain", "forbidden host");
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return send(res, 200, "text/html; charset=utf-8", readFileSync(PAGE), "no-cache");
      }
      if (url.pathname === "/api/usage") {
        const q = url.searchParams;
        if (q.get("fresh")) resetSnapshots();
        const filters = Object.fromEntries(
          ["range", "from", "to", "host", "harness", "project", "model", "q", "group"].filter((k) => q.get(k)).map((k) => [k, q.get(k)]),
        );
        return sessionIndex().then(
          (threadsBySession) => send(res, 200, "application/json", JSON.stringify({ ...summarize(filters, { threadsBySession }), billing: detectBilling() })),
        ).catch((error) => send(res, 500, "application/json", JSON.stringify({ error: error.message })));
      }
      if (url.pathname === "/api/models") {
        const q = url.searchParams;
        const filters = Object.fromEntries(["range", "from", "to", "host", "harness", "project"].filter((k) => q.get(k)).map((k) => [k, q.get(k)]));
        return modelsReport(filters, { offline: runOffline, fresh: Boolean(q.get("fresh")) }).then(
          (body) => send(res, 200, "application/json", JSON.stringify(body)),
          (error) => send(res, 500, "application/json", JSON.stringify({ error: error.message })),
        );
      }
      if (url.pathname === "/api/rates") {
        return usdRates({ offline: runOffline }).then(
          (rates) => send(res, rates ? 200 : 503, "application/json", JSON.stringify(rates ?? { error: "no exchange rate has been fetched yet" })),
          (error) => send(res, 500, "application/json", JSON.stringify({ error: error.message })),
        );
      }
      if (url.pathname === "/api/icons") return send(res, 200, "application/json", JSON.stringify({ available: listIcons() }));
      if (url.pathname === "/api/icons/ensure") {
        const names = (url.searchParams.get("names") ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
        return ensureIcons(names, { offline: runOffline }).then(
          (found) => send(res, 200, "application/json", JSON.stringify(found)),
          (error) => send(res, 500, "application/json", JSON.stringify({ error: error.message })),
        );
      }
      if (url.pathname === "/api/events") return serveEvents(req, res);
      if (url.pathname === "/api/ping") return send(res, 200, "application/json", JSON.stringify({ app: "usage-web", pid: process.pid }));
      if (url.pathname === "/favicon.ico") return serveAsset(res, "/assets/favicon.svg");
      if (url.pathname === "/api/limits") {
        return detectLimits({ fresh: Boolean(url.searchParams.get("fresh")) }).then(
          (body) => send(res, 200, "application/json", JSON.stringify(body)),
          (error) => send(res, 500, "application/json", JSON.stringify({ error: error.message })),
        );
      }
      if (url.pathname.startsWith("/api/threads")) return serveThreads(res, url);
      if (url.pathname.startsWith("/assets/")) return serveAsset(res, url.pathname);
      return send(res, 404, "text/plain", "not found");
    } catch (error) {
      return send(res, 500, "application/json", JSON.stringify({ error: error.message }));
    }
  });
}

// atuin may be missing (a box that never installed it): that is a normal state for
// the page to explain, not a server error.
const RESUME_TARGETS = ["claude-code", "codex", "copilot", "grok", "hermes", "kiro", "opencode", "pi", "omp", "amp"];

function serveThreads(res, url) {
  const q = url.searchParams;
  const json = (status, body) => send(res, status, "application/json", JSON.stringify(body));
  if (url.pathname === "/api/threads/file") {
    threadFile(q.get("id") ?? "", q.get("path") ?? "", { host: q.get("host") ?? "" }).then((body) => json(200, body), (error) => json(error.status ?? 400, { error: error.message, hosts: error.hosts }));
    return;
  }
  if (url.pathname === "/api/threads/repo") {
    threadRepo(q.get("id") ?? "", q.get("branch") ?? "").then((body) => json(200, body), (error) => json(error.status ?? 400, { error: error.message }));
    return;
  }
  if (url.pathname === "/api/threads/folder") {
    if (res.req.method !== "POST" || res.req.headers["x-usage-action"] !== "1") return json(405, { error: "POST with x-usage-action: 1" });
    openThreadFolder(q.get("id") ?? "").then((body) => json(200, body), (error) => json(error.status ?? 400, { error: error.message }));
    return;
  }
  if (url.pathname === "/api/threads/reveal") {
    // Opens a window on this machine, so it is a POST that also needs a header a web page on another
    // origin cannot send without a preflight this server never answers.
    if (res.req.method !== "POST" || res.req.headers["x-usage-action"] !== "1") return json(405, { error: "POST with x-usage-action: 1" });
    revealFile(q.get("id") ?? "", q.get("path") ?? "").then((body) => json(200, body), (error) => json(error.status ?? 400, { error: error.message }));
    return;
  }
  if (url.pathname === "/api/threads/image") {
    // A picture a thread names by path. An SVG is served sandboxed so that script inside it cannot run.
    threadImage(q.get("id") ?? "", q.get("path") ?? "").then(
      ({ type, data }) => {
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        res.end(data);
      },
      (error) => send(res, error.status ?? 400, "text/plain", error.message),
    );
    return;
  }
  let job;
  if (url.pathname === "/api/threads") {
    job = listThreads({
      q: q.get("q") ?? "", harness: q.get("harness") ?? "all", host: q.get("host") ?? "all", model: q.get("model") ?? "all",
      project: q.get("project") ?? "all", days: q.get("days") ?? 0, limit: q.get("limit") ?? 200, offset: q.get("offset") ?? 0,
      subagents: q.get("subagents") === "1", fresh: q.get("fresh") === "1",
    });
  } else if (url.pathname === "/api/threads/show") {
    job = showThread(q.get("id") ?? "", { offset: q.get("offset"), limit: q.get("limit"), fresh: q.get("fresh") === "1" });
  } else if (url.pathname === "/api/threads/resume") {
    job = resumeCommands(q.get("id") ?? "", RESUME_TARGETS);
  } else {
    return json(404, { error: "not found" });
  }
  job.then(
    (body) => json(200, body),
    (error) => json(error.missing ? 200 : 400, error.missing ? { unavailable: error.message } : { error: error.message }),
  );
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

// Is a usage dashboard already answering on one of these loopback ports? /api/ping
// names it exactly; a server older than that route is recognised by its page title.
export async function findRunningWeb(ports, timeoutMs = 700) {
  for (const port of ports) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const ping = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
      if (ping.ok && (await ping.json().catch(() => null))?.app === "usage-web") return port;
      if (ping.status === 404) {
        const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(timeoutMs) });
        if (page.ok && (await page.text()).includes("<title>Usage</title>")) return port;
      }
    } catch { /* nothing listening there, or not ours */ }
  }
  return null;
}

async function startWeb({ port, host = "127.0.0.1", open = true, offline = false } = {}) {
  runOffline = offline;
  // One bad request must never take the dashboard down.
  process.on("unhandledRejection", (error) => console.log(`web: unhandled rejection (${error?.message ?? error})`));
  if (!offline) {
    if (catalogIsStale()) refreshCatalog().catch((error) => console.log(`models: refresh failed (${error.message})`));
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

  // `usage web` with a browser means "show me the dashboard". If the background
  // service (or an earlier run) already serves one, open that instead of starting a
  // second server on the next free port. --no-open is how the service itself starts,
  // so it never defers, or a service restart would exit and be restarted in a loop.
  if (open && (host === "127.0.0.1" || host === "localhost")) {
    const wanted = Number(port);
    const candidates = wanted ? [wanted] : [installedPort(), ...Array.from({ length: 20 }, (_, i) => DEFAULT_PORT + i)];
    const running = await findRunningWeb([...new Set(candidates)]);
    if (running) {
      const existing = `http://127.0.0.1:${running}/`;
      console.log(`usage web: already running at ${existing}`);
      openBrowser(existing);
      return null;
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
  // Warm what the first page load asks for, so it is answered from memory. Failures are fine:
  // it is only a head start.
  setTimeout(() => {
    for (const u of ["/api/usage?range=30d&group=project", "/api/models", "/api/limits", "/api/threads?limit=200"]) fetch(`http://127.0.0.1:${actual}${u}`).catch(() => {});
  }, 400);
  return server;
}

export { summarize, startWeb };
