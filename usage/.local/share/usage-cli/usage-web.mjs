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
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectLimits } from "./usage-limits.mjs";
import { listThreads, resumeCommands, sessionIndex, showThread } from "./usage-threads.mjs";
import { loadPriceCache, refreshPrices, usageDir } from "./usage.mjs";
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

function send(res, status, type, body, cache = "no-store") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": cache });
  res.end(body);
}

// Static files under usage-web-assets only. The resolved path has to stay inside
// the folder, so `/assets/../../.ssh/config` cannot walk out of it.
function serveAsset(res, pathname) {
  const target = path.resolve(ASSETS, decodeURIComponent(pathname.slice("/assets/".length)));
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
        if (q.get("fresh")) resetSnapshots();
        const filters = Object.fromEntries(
          ["range", "from", "to", "host", "harness", "project", "model", "q", "group"].filter((k) => q.get(k)).map((k) => [k, q.get(k)]),
        );
        return sessionIndex().then(
          (threadsBySession) => send(res, 200, "application/json", JSON.stringify(summarize(filters, { threadsBySession }))),
          (error) => send(res, 500, "application/json", JSON.stringify({ error: error.message })),
        );
      }
      if (url.pathname === "/api/models") {
        const q = url.searchParams;
        const filters = Object.fromEntries(["range", "from", "to", "host", "harness", "project"].filter((k) => q.get(k)).map((k) => [k, q.get(k)]));
        return modelsReport(filters, { offline: runOffline, fresh: Boolean(q.get("fresh")) }).then(
          (body) => send(res, 200, "application/json", JSON.stringify(body)),
          (error) => send(res, 500, "application/json", JSON.stringify({ error: error.message })),
        );
      }
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
  let job;
  if (url.pathname === "/api/threads") {
    job = listThreads({
      q: q.get("q") ?? "", harness: q.get("harness") ?? "all",
      subagents: q.get("subagents") === "1", fresh: q.get("fresh") === "1",
    });
  } else if (url.pathname === "/api/threads/show") {
    job = showThread(q.get("id") ?? "", { offset: q.get("offset") });
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

async function startWeb({ port = DEFAULT_PORT, host = "127.0.0.1", open = true, offline = false } = {}) {
  runOffline = offline;
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
