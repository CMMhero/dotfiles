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

import { execFile } from "node:child_process";
import { findTool } from "./usage-env.mjs";
import { prepare, scoreThread } from "./usage-fuzzy.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const HARNESS = /^[a-z][a-z0-9-]{1,20}$/;
const LIST_TTL_MS = 10_000;
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
async function allThreads(fresh) {
  if (!fresh && listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.threads;
  const threads = JSON.parse(await run(["threads", "list", "--style", "json"]));
  await nameMachines(threads);
  listCache = { at: Date.now(), threads };
  return threads;
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

function block(entry) {
  switch (entry?.type) {
    case "text":
      return { type: "text", text: clip(entry.text, CAP.text) };
    case "thinking":
      return { type: "thinking", text: clip(entry.text, CAP.thinking) };
    case "tool_call":
      return { type: "tool_call", name: entry.name, input: clip(entry.input, CAP.input) };
    case "tool_result":
      return { type: "tool_result", text: clip(entry.content, CAP.result) };
    case "patch":
      return {
        type: "patch",
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

export async function showThread(id, { offset = 0, limit = MAX_MESSAGES } = {}) {
  if (!ID.test(id)) throw new Error("bad thread id");
  let entry = showCache.get(id);
  if (!entry || Date.now() - entry.at > SHOW_TTL_MS) {
    const body = JSON.parse(await run(["threads", "show", id, "--style", "json"], 60_000));
    entry = { at: Date.now(), session: body.session, messages: (body.messages ?? []).filter((m) => !SKIP_ROLES.has(m.role) && m.content?.length) };
    showCache.set(id, entry);
    if (showCache.size > 8) showCache.delete(showCache.keys().next().value);
  }
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
