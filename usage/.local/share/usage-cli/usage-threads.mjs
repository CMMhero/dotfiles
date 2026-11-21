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
const CAP = { text: 8000, thinking: 6000, input: 2000, result: 2500, diff: 4000 };
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



// ---- reaching the machine a thread ran on -------------------------------------------------------------
// A thread from another machine names paths that do not exist here. Rather than ask which machine to
// try, the server asks them all: every host in USAGE_REMOTE_HOSTS, in parallel, with a short timeout,
// and uses the first that has the path. The host that answered is remembered per atuin host id, so the
// next request for that machine goes straight to it. A host can be Linux or macOS (sh) or Windows
// (OpenSSH with PowerShell); the first ssh finds out which. Both kinds are handed their script as
// base64, so no path or quote can break out of it.
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR"];
const psCommand = (script) => `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
const kinds = new Map();      // ssh host -> { kind: "posix" | "windows" | "none", at }
const KIND_TTL_MS = 60_000;   // an unreachable host is asked again after a minute

async function hostKind(host) {
  const hit = kinds.get(host);
  if (hit && (hit.kind !== "none" || Date.now() - hit.at < KIND_TTL_MS)) return hit.kind;
  const probe = async () => {
    try { if (/^(Linux|Darwin|FreeBSD)/.test((await capture("ssh", [...SSH_OPTS, host, "uname -s"], { timeout: 12_000 })).toString().trim())) return "posix"; } catch { /* not a posix shell */ }
    try { if (/^\d+/.test((await capture("ssh", [...SSH_OPTS, host, psCommand("$PSVersionTable.PSVersion.Major")], { timeout: 15_000 })).toString().trim())) return "windows"; } catch { /* not windows either */ }
    return "none";
  };
  const pending = probe().then((kind) => { kinds.set(host, { kind, at: Date.now() }); return kind; });
  kinds.set(host, { kind: pending, at: Date.now() });
  return pending;
}
const kindOf = async (host) => { const k = kinds.get(host)?.kind; return typeof k === "string" ? k : hostKind(host); };

// The same place, spelled the way each kind of machine spells it: D:\x on Windows is /mnt/d/x on WSL.
export function pathVariants(given, kind) {
  const win = /^[A-Za-z]:[\\/]/.test(given), mnt = /^\/mnt\/([a-z])\/(.*)$/i.exec(given);
  if (kind === "windows") {
    if (win) return [given];
    return mnt ? [`${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, "\\")}`] : [];
  }
  if (win) return [`/mnt/${given[0].toLowerCase()}/${given.slice(3).replace(/\\/g, "/")}`];
  return [given];
}


// Hosts to ask. USAGE_REMOTE_HOSTS, when set, is the whole list. When it is not, the defaults are joined
// by every alias in ~/.ssh/config (so `linux` for WSL, a Windows PC, a VPS are all tried without being
// listed), with aliases that point to the same host:port:user counted once.
let discovered = { at: 0, list: [] };
async function sshAliases() {
  if (Date.now() - discovered.at < 10 * 60_000) return discovered.list;
  let names = [];
  try {
    const text = await readFile(path.join(os.homedir(), ".ssh", "config"), "utf8");
    for (const m of text.matchAll(/^\s*Host\s+(.+)$/gim)) for (const n of m[1].trim().split(/\s+/)) if (!/[*?!]/.test(n) && !/-public$/i.test(n)) names.push(n);
  } catch { /* no config: nothing to add */ }
  names = [...new Set(names)].slice(0, 24);
  const seen = new Map();
  await Promise.all(names.map(async (name) => {
    try {
      const cfg = Object.fromEntries((await capture("ssh", ["-G", name], { timeout: 5000 })).toString().split("\n").map((l) => { const i = l.indexOf(" "); return [l.slice(0, i), l.slice(i + 1)]; }));
      const key = `${cfg.user}@${cfg.hostname}:${cfg.port}`;
      if (!seen.has(key) || names.indexOf(name) < names.indexOf(seen.get(key))) seen.set(key, name);
    } catch { /* an alias ssh cannot read */ }
  }));
  const list = names.filter((n) => [...seen.values()].includes(n));
  discovered = { at: Date.now(), list };
  return list;
}
async function sshCandidates() {
  if (process.env.USAGE_REMOTE_HOSTS) return remoteHosts();
  // The same machine can appear as "it@space-pp" and as the alias "space-pp": ask each place once.
  const seen = new Map();
  for (const name of [...remoteHosts(), ...(await sshAliases())]) {
    let key = name;
    try {
      const cfg = Object.fromEntries((await capture("ssh", ["-G", name], { timeout: 5000 })).toString().split("\n").map((l) => { const i = l.indexOf(" "); return [l.slice(0, i), l.slice(i + 1)]; }));
      key = `${cfg.user}@${cfg.hostname}:${cfg.port}`;
    } catch { /* keep the name as its own key */ }
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()].slice(0, 10);
}

// The WSL distros of a Windows machine are folders to it: \\wsl.localhost\Ubuntu\home\me\x.
let distros = { at: 0, list: [] };
async function wslDistros() {
  if (process.platform !== "win32") return [];
  if (Date.now() - distros.at < 5 * 60_000) return distros.list;
  let list = [];
  try { list = (await capture("wsl.exe", ["-l", "-q"], { timeout: 6000 })).toString("utf16le").replace(/\u0000/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch { /* no WSL */ }
  distros = { at: Date.now(), list };
  return list;
}
// Every place on this machine a path written on any system could be.
async function localPaths(given) {
  const out = [normPath(given)];
  for (const v of pathVariants(given, process.platform === "win32" ? "windows" : "posix")) if (!out.includes(v)) out.push(v);
  if (process.platform === "win32" && given.startsWith("/") && !/^\/mnt\/[a-z]\//i.test(given)) {
    for (const d of await wslDistros()) out.push(`\\\\wsl.localhost\\${d}${given.replace(/\//g, "\\")}`);
  }
  return out;
}

const readScript = (kind, target, limit) => kind === "windows"
  ? `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(target)}'))
if(-not [IO.File]::Exists($p)){exit 3}
$f=[IO.File]::OpenRead($p)
try{$n=[int][Math]::Min($f.Length,${limit});$b=New-Object byte[] $n;[void]$f.Read($b,0,$n);Write-Output $f.Length;Write-Output ([Convert]::ToBase64String($b))}finally{$f.Dispose()}`
  : `p=$(printf %s '${b64(target)}' | base64 -d)
case "$p" in "~/"*) p="$HOME/\${p#\\~/}";; esac
[ -f "$p" ] || exit 3
wc -c < "$p" | tr -d ' '
head -c ${limit} -- "$p" | base64 | tr -d '\\n'
echo`;
const gitScript = (kind, target) => kind === "windows"
  ? `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(target)}'))
if(-not [IO.Directory]::Exists($p)){exit 3}
git -C $p remote get-url origin 2>$null
Write-Output '---'
git -C $p rev-parse --abbrev-ref HEAD 2>$null
exit 0`
  : `p=$(printf %s '${b64(target)}' | base64 -d)
case "$p" in "~/"*) p="$HOME/\${p#\\~/}";; esac
[ -d "$p" ] || exit 3
git -C "$p" remote get-url origin 2>/dev/null
echo ---
git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null
exit 0`;
const runRemote = (host, kind, script, timeout = 25_000) =>
  capture("ssh", [...SSH_OPTS, host, kind === "windows" ? psCommand(script) : `echo ${b64(script)} | base64 -d | sh`], { timeout });

const winners = new Map();   // atuin host id -> ssh host that had that machine's files
const remoteCache = new Map(); // "host|path|limit" -> { at, value }
const REMOTE_TTL_MS = 60_000;

// Ask the candidate hosts which has the thing; `ask(host, kind)` resolves with a value or rejects. The
// host that answered last time for this machine goes first, and the others follow in the same instant.
async function fromAnyHost(entry, ask) {
  const machine = entry.session?.host ?? "";
  const all = await sshCandidates();
  const pref = winners.get(machine);
  const order = pref && all.includes(pref) ? [pref, ...all.filter((h) => h !== pref)] : all;
  if (!order.length) throw fail("no remote hosts are configured (USAGE_REMOTE_HOSTS)", 404, { hosts: [] });
  const tries = order.map((host) => (async () => {
    const kind = await kindOf(host);
    if (kind === "none") throw new Error(`${host}: not reachable`);
    return { host, value: await ask(host, kind) };
  })());
  try {
    const { host, value } = await Promise.any(tries);
    if (machine) winners.set(machine, host);
    return { host, value };
  } catch (e) {
    throw fail("that is not on this machine, and none of the other machines have it", 404, { hosts: all, tried: (e.errors ?? []).map((x) => x.message).slice(0, 8) });
  }
}

async function readRemote(entry, given, limit, only = "") {
  const ask = async (host, kind) => {
    for (const target of kind === "windows" ? pathVariants(given, kind) : given.startsWith("~/") ? [given] : pathVariants(given, kind)) {
      const key = `${host}|${target}|${limit}`, hit = remoteCache.get(key);
      if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.value;
      try {
        const [size, data = ""] = (await runRemote(host, kind, readScript(kind, target, limit))).toString().trim().split(/\r?\n/);
        const value = { path: target, size: Number(size), buf: Buffer.from(data.trim(), "base64") };
        remoteCache.set(key, { at: Date.now(), value });
        if (remoteCache.size > 24) remoteCache.delete(remoteCache.keys().next().value);
        return value;
      } catch { /* not at that spelling */ }
    }
    throw new Error(`${host}: no such file`);
  };
  if (only) return { host: only, value: await ask(only, await kindOf(only)) };
  return fromAnyHost(entry, ask);
}

// ---- images --------------------------------------------------------------------------
// Messages point at pictures by path (a pasted screenshot, a saved attachment, a markdown
// image). The browser cannot open a path on disk, so the server reads it, but only an image
// file whose path is written in the thread being read. That keeps this from being a way to
// read arbitrary files: it can only show what the conversation itself already names.
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".svg": "image/svg+xml" };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_LIMIT = 4 * 1024 * 1024;

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
  const type = IMAGE_TYPES[(/\.[A-Za-z0-9]+$/.exec(resolved)?.[0] ?? "").toLowerCase()];
  if (!type || !isAbs(resolved)) throw Object.assign(new Error("not an image path"), { status: 400 });
  if (!mentions(entry, text) && !mentions(entry, resolved)) throw Object.assign(new Error("this thread does not mention that file"), { status: 403 });
  for (const here of await localPaths(text)) {
    const info = await stat(here).catch(() => null);
    if (!info?.isFile()) continue;
    if (info.size > MAX_IMAGE_BYTES) throw Object.assign(new Error("image too large"), { status: 413 });
    return { type, data: await readFile(here) };
  }
  // Not on this machine: the one the thread ran on has it.
  const { value } = await readRemote(entry, text, IMAGE_LIMIT);
  if (value.size > IMAGE_LIMIT) throw Object.assign(new Error("image too large to fetch from another machine"), { status: 413 });
  return { type, data: value.buf, via: value.host };
}


// ---- files a thread mentions -------------------------------------------------------------
// A path in a conversation can be opened from the page: shown here (read-only, text up to 400 KB,
// images inline), revealed in the file manager, or, when it lives on another machine, read over ssh
// from one of the hosts in USAGE_REMOTE_HOSTS. Same rule as images: only a path that is written in
// the thread being read, and only read access, so this is no way to browse the disk.
const TEXT_LIMIT = 400 * 1024;
function normPath(file) {
  let t = String(file ?? "").replace(/^file:\/\//, "");
  try { t = decodeURIComponent(t); } catch { /* keep it raw */ }
  t = t.replace(/^\/([A-Za-z]:[\\/])/, "$1");
  return t.startsWith("~/") ? path.join(os.homedir(), t.slice(2)) : t;
}
const normSpelling = (file) => {
  let t = String(file ?? "").replace(/^file:\/\//, "");
  try { t = decodeURIComponent(t); } catch { /* keep it raw */ }
  return t.replace(/^\/([A-Za-z]:[\\/])/, "$1");
};
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
  if (!isAbs(resolved) && !/^~\//.test(given)) throw fail("not an absolute path", 400);
  if (!mentions(entry, given) && !mentions(entry, resolved)) throw fail("this thread does not mention that file", 403);
  return resolved;
}

export async function threadFile(id, file, { host = "" } = {}) {
  const resolved = await guard(id, file), ext = (/\.[A-Za-z0-9]+$/.exec(resolved)?.[0] ?? "").toLowerCase();
  const entry = await loadEntry(id), given = normSpelling(file);
  const image = IMAGE_TYPES[ext];
  const viaRemote = ({ host: via, value }) => {
    if (image) return { path: value.path, via, kind: "image", size: value.size, dataUrl: value.buf.length && value.size <= IMAGE_LIMIT ? `data:${image};base64,${value.buf.toString("base64")}` : null, ext };
    if (looksBinary(value.buf)) return { path: value.path, via, kind: "binary", size: value.size, ext };
    return { path: value.path, via, kind: "text", size: value.size, text: value.buf.subarray(0, TEXT_LIMIT).toString("utf8"), truncated: value.size > TEXT_LIMIT, ext };
  };
  if (host) {
    if (!(await sshCandidates()).includes(host)) throw fail("not one of the configured hosts", 400);
    return viaRemote(await readRemote(entry, given, image ? IMAGE_LIMIT : TEXT_LIMIT, host));
  }
  for (const here of await localPaths(file)) {
    const info = await stat(here).catch(() => null);
    if (!info?.isFile()) continue;
    const base = { path: here, via: "this machine", size: info.size, mtime: info.mtime.toISOString(), ext };
    if (image) return { ...base, kind: "image" };
    const handle = await open(here, "r");
    try {
      const buf = Buffer.alloc(Math.min(info.size, TEXT_LIMIT + 1));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const data = buf.subarray(0, bytesRead);
      if (looksBinary(data)) return { ...base, kind: "binary" };
      return { ...base, kind: "text", text: data.subarray(0, TEXT_LIMIT).toString("utf8"), truncated: info.size > TEXT_LIMIT };
    } finally { await handle.close(); }
  }
  // Not here: ask the other machines, all at once. 404 (with the hosts) only if none has it.
  return viaRemote(await readRemote(entry, given, image ? IMAGE_LIMIT : TEXT_LIMIT));
}

// Show the file in the system file manager (selected, where the platform can). Only a file that exists
// here and is named in the thread.
export async function revealFile(id, file) {
  const first = await guard(id, file);
  let resolved = first, info = null;
  for (const here of await localPaths(file)) { info = await stat(here).catch(() => null); if (info) { resolved = here; break; } }
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
  const given = normSpelling(entry.session?.cwd ?? "");
  if (!given || !isAbs(given)) throw fail("this thread recorded no folder", 400);
  return { entry, given };
}
async function localFolder(given) {
  for (const here of await localPaths(given)) { const info = await stat(here).catch(() => null); if (info?.isDirectory()) return here; }
  return null;
}

export async function threadRepo(id, recordedBranch = "") {
  const { entry, given } = await threadCwd(id);
  let cwd = await localFolder(given), via = "this machine", remote = "", branch = "", root = null;
  if (cwd) {
    const git = (args) => capture("git", ["-C", cwd, ...args], { timeout: 8000 }).then((b) => b.toString().trim()).catch(() => "");
    [root, remote, branch] = await Promise.all([git(["rev-parse", "--show-toplevel"]), git(["remote", "get-url", "origin"]), git(["rev-parse", "--abbrev-ref", "HEAD"])]);
  } else {
    // The folder is on the machine the thread ran on: ask that machine's git.
    const ask = async (host, kind) => {
      for (const target of pathVariants(given, kind)) {
        try {
          const lines = (await runRemote(host, kind, gitScript(kind, target), 20_000)).toString().split(/\r?\n/).map((l) => l.trim());
          const cut = lines.indexOf("---");
          return { target, remote: cut > 0 ? lines.slice(0, cut).join("") : "", branch: cut >= 0 ? lines[cut + 1] ?? "" : "" };
        } catch { /* not at that spelling */ }
      }
      throw new Error(`${host}: no such folder`);
    };
    const got = await fromAnyHost(entry, ask);
    via = got.host; cwd = got.value.target; remote = got.value.remote; branch = got.value.branch;
  }
  const web = webUrlOf(remote), name = web ? web.split("/").slice(-2).join("/") : "";
  const head = branch && branch !== "HEAD" ? branch : null;
  return { cwd, via, root: root || null, remote: remote || null, web, name, branch: head, branchUrl: branchUrlOf(web, /^[\w./@+-]{1,200}$/.test(recordedBranch) ? recordedBranch : head) };
}

export async function openThreadFolder(id) {
  const { given } = await threadCwd(id);
  const cwd = await localFolder(given);
  if (!cwd) throw fail("that folder is not on this machine", 404);
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

// Exposed for the tests of the remote scripts; not part of the page's API.
export const _remote = { readScript, gitScript, psCommand, pathVariants };
