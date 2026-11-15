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
    execFile("atuin", args, { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout, windowsHide: true }, (error, stdout, stderr) => {
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

let listCache = null;
async function allThreads(fresh) {
  if (!fresh && listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.threads;
  const threads = JSON.parse(await run(["threads", "list", "--style", "json"]));
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

export async function listThreads({ q = "", harness = "all", subagents = false, limit = 200, fresh = false } = {}) {
  if (harness !== "all" && !HARNESS.test(harness)) throw new Error("bad harness");
  let threads;
  const query = String(q).trim();
  if (query) {
    // Atuin's own full-text search (titles, messages, reasoning, tool calls), best
    // match first. Words are separate argv entries after `--`, so a query that
    // starts with a dash is still a query.
    const args = ["threads", "search", "--limit", String(Math.min(limit, 100)), "--style", "json"];
    if (harness !== "all") args.push("--harness", harness);
    args.push("--", ...query.split(/\s+/).slice(0, 12));
    threads = JSON.parse(await run(args)).map((hit) => hit.session ?? hit);
  } else {
    threads = await allThreads(fresh);
    if (harness !== "all") threads = threads.filter((t) => t.harness === harness);
  }
  const harnesses = [...new Set((await allThreads(false)).map((t) => t.harness))].sort();
  const visible = subagents ? threads : threads.filter((t) => t.parent_kind !== "subagent");
  return {
    total: visible.length,
    hiddenSubagents: threads.length - visible.length,
    harnesses,
    threads: visible.slice(0, limit).map(brief),
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

export async function showThread(id, { offset = 0 } = {}) {
  if (!ID.test(id)) throw new Error("bad thread id");
  const body = JSON.parse(await run(["threads", "show", id, "--style", "json"], 60_000));
  const messages = (body.messages ?? []).filter((m) => !SKIP_ROLES.has(m.role) && m.content?.length);
  const start = Math.max(0, Number(offset) || 0);
  return {
    thread: brief(body.session),
    total: messages.length,
    offset: start,
    messages: messages.slice(start, start + MAX_MESSAGES).map((m) => ({
      role: m.role,
      at: m.timestamp ?? null,
      model: m.model ?? null,
      tokens: m.tokens ?? null,
      content: m.content.map(block),
    })),
  };
}

// The command that resumes a thread on this machine. `--print` makes atuin say
// what it would run instead of running it. The fork and cross-agent lines are
// built here as text and never executed (see the header).
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
