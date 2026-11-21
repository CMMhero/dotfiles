// ==============================================================================
// usage-threads.mjs - browse atuin's captured agent threads from the dashboard.
//
// Atuin already records every Claude Code, Codex, opencode, pi and omp session as a
// thread and knows how to resume each one. This file only shells out to
// `atuin threads` (list, search, show, resume --print) and trims the answers for
// a browser. It reads nothing from the agents' own stores.
//
// Resume is a COMMAND, not an action. A web page cannot hand a terminal to an
// agent, so `resume` returns the exact line to run (`cd <dir> && claude --resume
// <id>`) and the page copies it. Nothing here starts an agent. Fork and
// continue-in-another-agent are returned as text only: `atuin threads resume
// --fork` writes a new session even with --print, so running it to preview a
// command would leave a stray session behind.
//
// Arguments go to execFile as an argv array, never through a shell, and thread
// ids must match a strict pattern, so a crafted id cannot become a flag or a
// command.
// ==============================================================================

import { execFile, spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findTool } from "./usage-env.mjs";
import { remoteHosts } from "./usage-limits.mjs";
import { prepare, scoreThread } from "./usage-fuzzy.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const HARNESS = /^[a-z][a-z0-9-]{1,20}$/;
const LIST_TTL_MS = 6_000;
const MAX_BUFFER = 256 * 1024 * 1024;

// Caps for the detail view. Tool output can run to megabytes and a browser does
// not need it to follow a conversation.
const CAP = { text: 8000, thinking: 1500, input: 2000, result: 2500, diff: 4000 };
const MAX_MESSAGES = 500;

function run(args, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    // atuin is usually a mise shim, which this process may not have on PATH.
    const tool = findTool("atuin");
    if (!tool) return reject(Object.assign(new Error("atuin is not installed or not on PATH"), { missing: true }));
    execFile(tool.cmd, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout, windowsHide: true, env: tool.env, shell: tool.shell }, (error, stdout, stderr) => {
      if (error) {
        const missing = error.code === "ENOENT";
        reject(Object.assign(new Error(missing ? "atuin is not installed or not on PATH" : (stderr || error.message).trim()), { missing }));
      } else {
        resolve(stdout);
      }
    });
  });
}

const clip = (value, limit) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters` : text;
};

function brief(thread) {
  return {
    id: thread.atuin_id,
    session: thread.session_id,
    harness: thread.harness,
    host: thread.host ?? null,
    machine: machines?.get(thread.host)?.label ?? null,
    title: thread.title ?? "",
    preview: clip(thread.preview ?? "", 240),
    cwd: thread.cwd ?? null,
    branch: thread.git_branch ?? null,
    model: thread.model ?? null,
    startedAt: thread.started_at ?? null,
    updatedAt: thread.updated_at ?? null,
    messages: thread.message_count ?? 0,
    tokens: thread.tokens ?? null,
    subagent: thread.parent_kind === "subagent",
    parent: thread.parent_atuin_id ?? null,
  };
}

const folderOf = (cwd) => String(cwd ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";

// atuin knows a machine only by an id. A name is worked out from the folders its
// threads ran in: the account in /home/<user> or C:\Users\<user>, and the system
// those paths belong to. Two machines that come out alike get the end of their id
// appended, and the one this server runs on is marked.
let machines = null;
let localHost;

// Pure: atuin host id -> { id, base, label, count } from the folders the threads ran in.
export function labelMachines(threads, localHostId = null) {
  const seen = new Map();
  for (const thread of threads) {
    if (!thread.host) continue;
    const entry = seen.get(thread.host) ?? { count: 0, users: new Map(), win: 0, wsl: 0, nix: 0 };
    entry.count += 1;
    const cwd = String(thread.cwd ?? "");
    const user = /^[A-Za-z]:\\Users\\([^\\]+)/.exec(cwd)?.[1] ?? /^\/(?:home|Users)\/([^/]+)/.exec(cwd)?.[1] ?? /^\/mnt\/[a-z]\/Users\/([^/]+)/.exec(cwd)?.[1];
    if (user) entry.users.set(user, (entry.users.get(user) ?? 0) + 1);
    if (/^[A-Za-z]:\\/.test(cwd)) entry.win += 1;
    else if (/^\/mnt\/[a-z]\//.test(cwd)) entry.wsl += 1;
    else if (cwd.startsWith("/")) entry.nix += 1;
    seen.set(thread.host, entry);
  }
  const labels = new Map();
  for (const [id, e] of seen) {
    const user = [...e.users.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    const os = e.win >= e.nix + e.wsl ? "Windows" : e.wsl ? "WSL" : "Linux";
    labels.set(id, { id, base: `${user} · ${os}`, count: e.count });
  }
  const dupes = new Map();
  for (const l of labels.values()) dupes.set(l.base, (dupes.get(l.base) ?? 0) + 1);
  for (const l of labels.values()) l.label = `${l.base}${dupes.get(l.base) > 1 ? ` · ${l.id.slice(-4)}` : ""}${l.id === localHostId ? " (this machine)" : ""}`;
  return labels;
}

async function nameMachines(threads) {
  if (localHost === undefined) {
    try { localHost = /host id:\s*(\w+)/.exec(await run(["info"], 10_000))?.[1] ?? null; } catch { localHost = null; }
  }
  machines = labelMachines(threads, localHost);
}

const preparedCache = new WeakMap(); // thread object -> its searchable fields, built once per list refresh
let listCache = null;
let listFlight = null;
async function loadAllThreads() {
  const threads = JSON.parse(await run(["threads", "list", "--style", "json"]));
  await nameMachines(threads);
  listCache = { at: Date.now(), threads };
  return threads;
}
// The list is an external command that takes a second or two. A list that is a few seconds old
// is returned at once and refreshed behind the request, so the page never waits on it twice;
// only the very first call, or an explicit refresh, waits for the command.
async function allThreads(fresh) {
  const age = listCache ? Date.now() - listCache.at : Infinity;
  if (!fresh && listCache && age < LIST_TTL_MS) return listCache.threads;
  if (!fresh && listCache) {
    listFlight ??= loadAllThreads().catch(() => {}).finally(() => { listFlight = null; });
    return listCache.threads;
  }
  listFlight ??= loadAllThreads().finally(() => { listFlight = null; });
  return listFlight;
}

// A cheap fingerprint of the thread list (how many, and the newest few), for change events.
export async function threadsSignature() {
  const all = await allThreads(false);
  const top = [...all].sort((a, b) => Date.parse(b.updated_at ?? 0) - Date.parse(a.updated_at ?? 0)).slice(0, 6);
  return `${all.length}|${top.map((x) => `${x.atuin_id}:${x.updated_at}:${x.message_count}`).join(",")}`;
}

// session id -> { id, title } for every captured thread, so a usage row can be
// matched to the conversation behind it. Null when atuin is missing or fails:
// the dashboard works without thread titles.
export async function sessionIndex() {
  try {
    const map = new Map();
    for (const thread of await allThreads(false)) map.set(thread.session_id, { id: thread.atuin_id, title: thread.title ?? "" });
    return map;
  } catch {
    return null;
  }
}

const counted = (threads, key) => {
  const counts = new Map();
  for (const thread of threads) { const k = key(thread); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
};

export async function listThreads({ q = "", harness = "all", host = "all", model = "all", project = "all", days = 0, subagents = false, limit = 200, offset = 0, fresh = false } = {}) {
  if (harness !== "all" && !HARNESS.test(harness)) throw new Error("bad harness");
  const all = await allThreads(fresh);
  let threads = all;
  const query = String(q).trim();
  if (query) {
    // Two searches, merged. atuin's full text search reads messages, reasoning and tool
    // calls but is exact; the fuzzy score reads titles, folders, branches and models and
    // forgives typos and half-remembered words. A thread found by either is a result, and
    // one found by both ranks first. Words are separate argv entries after `--`, so a query
    // that starts with a dash is still a query. The other filters apply to the merged list.
    const fullText = new Map();
    try {
      const args = ["threads", "search", "--limit", "0", "--style", "json"];
      if (harness !== "all") args.push("--harness", harness);
      args.push("--", ...query.split(/\s+/).slice(0, 12));
      JSON.parse(await run(args)).forEach((hit, rank, hits) => fullText.set((hit.session ?? hit).atuin_id, 1 - rank / hits.length));
    } catch { /* atuin search failed: the fuzzy half still answers */ }
    const scored = [];
    for (const thread of all) {
      let prepared = preparedCache.get(thread);
      if (!prepared) preparedCache.set(thread, (prepared = prepare(thread)));
      const fuzzy = scoreThread(prepared, query);
      const text = fullText.get(thread.atuin_id);
      if (!fuzzy && text === undefined) continue;
      scored.push({ thread, score: fuzzy + (text === undefined ? 0 : 1.2 + 1.5 * text) });
    }
    scored.sort((a, b) => b.score - a.score || Date.parse(b.thread.updated_at ?? 0) - Date.parse(a.thread.updated_at ?? 0));
    threads = scored.map((x) => x.thread);
  }
  const since = Number(days) > 0 ? Date.now() - Number(days) * 86_400_000 : 0;
  const keep = (thread) =>
    (harness === "all" || thread.harness === harness) &&
    (host === "all" || thread.host === host) &&
    (model === "all" || thread.model === model) &&
    (project === "all" || folderOf(thread.cwd) === project) &&
    (!since || Date.parse(thread.updated_at) >= since);
  const matched = threads.filter(keep);
  const visible = subagents ? matched : matched.filter((thread) => thread.parent_kind !== "subagent");
  const top = Math.max(1, Math.min(5000, Number(limit) || 200));
  return {
    total: visible.length,
    hiddenSubagents: matched.length - visible.length,
    // Menus list everything atuin has, so choosing one filter does not empty the others.
    options: {
      machines: [...(machines?.values() ?? [])].sort((a, b) => b.count - a.count).map((m) => ({ value: m.id, label: m.label, count: m.count })),
      agents: counted(all, (thread) => thread.harness),
      models: counted(all, (thread) => thread.model),
      projects: counted(all, (thread) => folderOf(thread.cwd)).slice(0, 80),
    },
    harnesses: [...new Set(all.map((thread) => thread.harness))].sort(),
    offset: Math.max(0, Number(offset) || 0),
    threads: visible.slice(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + top).map(brief),
    ranked: Boolean(query),
  };
}

// A tool call's input arrives as a JSON string. The page draws the common tools as cards
// (a shell command, a todo list, a question with options), which needs the parsed object,
// so it is sent too, with any very long string clipped. `input` stays as the raw fallback.
function parsedArgs(input) {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) && !value.length) return null;
  const shrink = (v, depth = 0) => {
    if (typeof v === "string") return v.length > 6000 ? `${v.slice(0, 6000)}\n… ${v.length - 6000} more characters` : v;
    if (depth > 6 || v == null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.slice(0, 60).map((x) => shrink(x, depth + 1));
    return Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [k, shrink(x, depth + 1)]));
  };
  return shrink(value);
}

function block(entry) {
  switch (entry?.type) {
    case "text":
      return { type: "text", text: clip(entry.text, CAP.text) };
    case "thinking":
      return { type: "thinking", text: clip(entry.text, CAP.thinking) };
    case "tool_call":
      return { type: "tool_call", id: entry.id ?? null, name: entry.name, input: clip(entry.input, CAP.input), args: parsedArgs(entry.input) };
    case "tool_result":
      return { type: "tool_result", id: entry.tool_use_id ?? null, isError: Boolean(entry.is_error), text: clip(typeof entry.content === "string" ? entry.content : Array.isArray(entry.content) ? entry.content.map((c) => c?.text ?? "").join("\n") : entry.content, CAP.result) };
    case "summary":
    case "error":
      return { type: entry.type, text: clip(entry.text, CAP.text) };
    case "patch":
      return {
        type: "patch",
        id: entry.tool_use_id ?? null,
        files: (entry.files ?? []).slice(0, 20).map((f) => ({
          path: f.path, change: f.change, additions: f.additions ?? 0, deletions: f.deletions ?? 0, diff: clip(f.diff ?? "", CAP.diff),
        })),
      };
    default:
      return { type: entry?.type ?? "unknown" };
  }
}

// Roles that carry no conversation: bookkeeping rows atuin keeps for completeness.
const SKIP_ROLES = new Set(["attachment", "custom-title"]);

// One `atuin threads show` of a long thread takes seconds, and scrolling asks for the
// next page every few hundred milliseconds, so the parsed thread is kept briefly.
const showCache = new Map(); // id -> { at, session, messages }
const SHOW_TTL_MS = 30_000;

async function loadEntry(id, fresh = false) {
  if (!ID.test(id)) throw new Error("bad thread id");
  let entry = showCache.get(id);
  if (!entry || fresh || Date.now() - entry.at > SHOW_TTL_MS) {
    const body = JSON.parse(await run(["threads", "show", id, "--style", "json"], 60_000));
    entry = { at: Date.now(), session: body.session, messages: (body.messages ?? []).filter((m) => !SKIP_ROLES.has(m.role) && m.content?.length) };
    showCache.set(id, entry);
    if (showCache.size > 8) showCache.delete(showCache.keys().next().value);
  }
  return entry;
}

export async function showThread(id, { offset = 0, limit = MAX_MESSAGES, fresh = false } = {}) {
  const entry = await loadEntry(id, fresh);
  const start = Math.max(0, Number(offset) || 0);
  const count = Math.max(1, Math.min(MAX_MESSAGES, Number(limit) || MAX_MESSAGES));
  return {
    thread: brief(entry.session),
    total: entry.messages.length,
    offset: start,
    messages: entry.messages.slice(start, start + count).map((m) => ({
      role: m.role,
      at: m.timestamp ?? null,
      model: m.model ?? null,
      tokens: m.tokens ?? null,
      content: m.content.map(block),
    })),
  };
}


// ---- images --------------------------------------------------------------------------
// Messages point at pictures by path (a pasted screenshot, a saved attachment, a markdown
// image). The browser cannot open a path on disk, so the server reads it, but only an image
// file whose path is written in the thread being read. That keeps this from being a way to
// read arbitrary files: it can only show what the conversation itself already names.
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".svg": "image/svg+xml" };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function mentions(entry, file) {
  const needle = file.replace(/\\/g, "/").toLowerCase();
  const has = (v) => typeof v === "string" && v.replace(/\\/g, "/").toLowerCase().includes(needle);
  for (const m of entry.messages) {
    for (const b of m.content ?? []) {
      if (has(b.text) || has(typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? "")) || has(typeof b.content === "string" ? b.content : "")) return true;
    }
  }
  return false;
}

export async function threadImage(id, file) {
  const entry = await loadEntry(id);
  const text = String(file ?? "").replace(/^file:\/\//, "");
  const resolved = decodeURIComponent(text).replace(/^\/([A-Za-z]:[\\/])/, "$1"); // file:///C:/x -> C:/x
  const type = IMAGE_TYPES[path.extname(resolved).toLowerCase()];
  if (!type || !path.isAbsolute(resolved)) throw Object.assign(new Error("not an image path"), { status: 400 });
  if (!mentions(entry, text) && !mentions(entry, resolved)) throw Object.assign(new Error("this thread does not mention that file"), { status: 403 });
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) throw Object.assign(new Error("file not found on this machine"), { status: 404 });
  if (info.size > MAX_IMAGE_BYTES) throw Object.assign(new Error("image too large"), { status: 413 });
  return { type, data: await readFile(resolved) };
}


// ---- files a thread mentions -------------------------------------------------------------
// A path in a conversation can be opened from the page: shown here (read-only, text up to 400 KB,
// images inline), revealed in the file manager, or, when it lives on another machine, read over ssh
// from one of the hosts in USAGE_REMOTE_HOSTS. Same rule as images: only a path that is written in
// the thread being read, and only read access, so this is no way to browse the disk.
const TEXT_LIMIT = 400 * 1024;
const IMAGE_LIMIT = 4 * 1024 * 1024;
function normPath(file) {
  let t = String(file ?? "").replace(/^file:\/\//, "");
  try { t = decodeURIComponent(t); } catch { /* keep it raw */ }
  t = t.replace(/^\/([A-Za-z]:[\\/])/, "$1");
  return t.startsWith("~/") ? path.join(os.homedir(), t.slice(2)) : t;
}
const isAbs = (p) => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
const fail = (message, status, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const looksBinary = (buf) => buf.subarray(0, 8192).includes(0);

function capture(cmd, args, { timeout = 20_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "buffer", timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => (error ? reject(fail(String(stderr).trim().split("\n").pop() || error.message, 502)) : resolve(stdout)));
  });
}

async function guard(id, file) {
  const entry = await loadEntry(id);
  const given = String(file ?? ""), resolved = normPath(given);
  if (!isAbs(resolved)) throw fail("not an absolute path", 400);
  if (!mentions(entry, given) && !mentions(entry, resolved)) throw fail("this thread does not mention that file", 403);
  return resolved;
}

export async function threadFile(id, file, { host = "" } = {}) {
  const resolved = await guard(id, file), ext = path.extname(resolved).toLowerCase();
  if (host) {
    if (!remoteHosts().includes(host)) throw fail("not one of the configured hosts", 400);
    // The path becomes one single-quoted argument of a remote sh, so only plain path characters are allowed.
    if (!/^[\w@%+=:,./~ -]+$/.test(resolved)) throw fail("that path has characters that are not read remotely", 400);
    const image = IMAGE_TYPES[ext];
    const script = image ? `head -c ${IMAGE_LIMIT + 1} -- '${resolved}' | base64 -w0` : `head -c ${TEXT_LIMIT + 1} -- '${resolved}'`;
    const out = await capture("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR", host, `sh -c "${script.replace(/"/g, '\\"')}"`]);
    if (image) { const b64 = out.toString().trim(); return { path: resolved, via: host, kind: "image", dataUrl: b64 && b64.length < IMAGE_LIMIT * 1.4 ? `data:${image};base64,${b64}` : null, ext }; }
    if (looksBinary(out)) return { path: resolved, via: host, kind: "binary", size: out.length, ext };
    return { path: resolved, via: host, kind: "text", text: out.subarray(0, TEXT_LIMIT).toString("utf8"), truncated: out.length > TEXT_LIMIT, ext };
  }
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) throw fail("that file is not on this machine", 404, { hosts: remoteHosts() });
  const base = { path: resolved, via: "this machine", size: info.size, mtime: info.mtime.toISOString(), ext };
  if (IMAGE_TYPES[ext]) return { ...base, kind: "image" };
  const handle = await open(resolved, "r");
  try {
    const buf = Buffer.alloc(Math.min(info.size, TEXT_LIMIT + 1));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const data = buf.subarray(0, bytesRead);
    if (looksBinary(data)) return { ...base, kind: "binary" };
    return { ...base, kind: "text", text: data.subarray(0, TEXT_LIMIT).toString("utf8"), truncated: info.size > TEXT_LIMIT };
  } finally { await handle.close(); }
}

// Show the file in the system file manager (selected, where the platform can). Only a file that exists
// here and is named in the thread.
export async function revealFile(id, file) {
  const resolved = await guard(id, file);
  const info = await stat(resolved).catch(() => null);
  if (!info) throw fail("that file is not on this machine", 404);
  const run = (cmd, args) => { const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false }); child.on("error", () => {}); child.unref(); };
  if (process.platform === "win32") run("explorer.exe", [`/select,${resolved.replace(/\//g, "\\")}`]);
  else if (process.platform === "darwin") run("open", ["-R", resolved]);
  else if (process.env.WSL_DISTRO_NAME) run("explorer.exe", [`/select,${(await capture("wslpath", ["-w", resolved])).toString().trim()}`]);
  else run("xdg-open", [info.isDirectory() ? resolved : path.dirname(resolved)]);
  return { ok: true };
}


// ---- the folder and the repository a thread ran in ------------------------------------------------
// The details panel can open the thread's folder in the file manager and its branch or repository on the
// web. Both answer only for the folder the thread itself recorded, and only if it exists on this machine.
export const webUrlOf = (remote) => {
  const r = String(remote ?? "").trim().replace(/\.git$/, "");
  const m = /^(?:git@|ssh:\/\/git@|git:\/\/)([^:/]+)[:/](.+)$/.exec(r) ?? /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(r);
  return m ? `https://${m[1]}/${m[2]}` : null;
};
const branchUrlOf = (web, branch) => {
  if (!web || !branch) return null;
  const host = new URL(web).hostname;
  return /gitlab/.test(host) ? `${web}/-/tree/${encodeURIComponent(branch).replace(/%2F/g, "/")}` : /bitbucket/.test(host) ? `${web}/branch/${encodeURIComponent(branch)}` : `${web}/tree/${encodeURIComponent(branch).replace(/%2F/g, "/")}`;
};
async function threadCwd(id) {
  const entry = await loadEntry(id);
  const cwd = normPath(entry.session?.cwd ?? "");
  if (!cwd || !isAbs(cwd)) throw fail("this thread recorded no folder", 400);
  return cwd;
}

export async function threadRepo(id, recordedBranch = "") {
  const cwd = await threadCwd(id);
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) throw fail("that folder is not on this machine", 404);
  const git = (args) => capture("git", ["-C", cwd, ...args], { timeout: 8000 }).then((b) => b.toString().trim()).catch(() => "");
  const [root, remote, branch] = await Promise.all([git(["rev-parse", "--show-toplevel"]), git(["remote", "get-url", "origin"]), git(["rev-parse", "--abbrev-ref", "HEAD"])]);
  const web = webUrlOf(remote), name = web ? web.split("/").slice(-2).join("/") : "";
  return { cwd, root: root || null, remote: remote || null, web, name, branch: branch && branch !== "HEAD" ? branch : null, branchUrl: branchUrlOf(web, /^[\w./@+-]{1,200}$/.test(recordedBranch) ? recordedBranch : branch && branch !== "HEAD" ? branch : null) };
}

export async function openThreadFolder(id) {
  const cwd = await threadCwd(id);
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) throw fail("that folder is not on this machine", 404);
  const run = (cmd, args) => { const child = spawn(cmd, args, { detached: true, stdio: "ignore" }); child.on("error", () => {}); child.unref(); };
  if (process.platform === "win32") run("explorer.exe", [cwd.replace(/\//g, "\\")]);
  else if (process.platform === "darwin") run("open", [cwd]);
  else if (process.env.WSL_DISTRO_NAME) run("explorer.exe", [(await capture("wslpath", ["-w", cwd])).toString().trim()]);
  else run("xdg-open", [cwd]);
  return { ok: true };
}

export async function resumeCommands(id, harnesses = []) {
  if (!ID.test(id)) throw new Error("bad thread id");
  // A thread that went on separately on another machine cannot be caught up by a
  // plain resume, and atuin says so instead of printing a command. `--as-is`
  // resumes this machine's copy, which is what "resume it here" means, so that
  // is the fallback, and the page says which one it got.
  let asIs = false;
  let printed;
  try {
    printed = await run(["threads", "resume", id, "--print"], 60_000);
  } catch (error) {
    if (error.missing) throw error;
    printed = await run(["threads", "resume", id, "--as-is", "--print"], 60_000);
    asIs = true;
  }
  // atuin may add a status line before the command; the command is the last one.
  const resume = printed.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return {
    resume,
    asIs,
    fork: `atuin threads resume ${id} --fork`,
    continueIn: Object.fromEntries(harnesses.filter((h) => HARNESS.test(h)).map((h) => [h, `atuin threads resume ${id} --in ${h}`])),
  };
}
