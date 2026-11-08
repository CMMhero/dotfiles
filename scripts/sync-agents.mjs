#!/usr/bin/env node
// ==============================================================================
// sync-agents.mjs - one agent roster, three harnesses.
//
//   node scripts/sync-agents.mjs              write omp + Claude files, report
//   node scripts/sync-agents.mjs --check      report drift, write nothing
//   node scripts/sync-agents.mjs --openbot    create/update agents in a running OpenBot
//
// Why a generator and not three hand-written copies: the roster is 21 agents and
// every harness disagrees about the format. omp reads frontmatter with
// autoloadSkills/spawns/model roles, Claude Code reads the same Markdown with
// different tool names (`Read`, `Grep`) and a different model vocabulary
// (`sonnet`, `opus`), and OpenBot has no agent files at all: its agents are
// runtime records created by an agent calling `create_agent`. Three hand-kept
// copies of the same prompt is the drift this repo spends effort avoiding
// elsewhere, so the roster lives in agents/agents.json and this writes the rest.
//
// pi, Codex and T3 Code need nothing here. None of them has a custom-agent
// registry: `codex agents` only browses sessions, `pi --help` has no loader, and
// T3 delegates to whichever provider CLI it runs, so it inherits that CLI's
// agents. Verified rather than assumed, on this machine.
// ==============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
// Where the roster lives, tried in order. The two repos keep it in different
// places because `agents/` is a stow package on the WSL side: a file dropped
// there lands in the home directory as `~/agents.json`, which is not a dotfile.
// An explicit override wins for anything unusual.
const ROSTER_CANDIDATES = [
	process.env.OMP_AGENT_ROSTER,
	path.join(REPO, "agents", "agents.json"),
	path.join(REPO, "agent-roster", "agents.json"),
	path.join(REPO, "omp", "roster", "agents.json"),
].filter(Boolean);
const ROSTER = ROSTER_CANDIDATES.find((candidate) => existsSync(candidate));
if (!ROSTER) {
	console.error(`No roster found. Looked in:\n${ROSTER_CANDIDATES.map((c) => `  ${c}`).join("\n")}`);
	process.exit(1);
}

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const OPENBOT = args.has("--openbot");

// ------------------------------------------------------------------------------
// Field mapping between harnesses
//
// Tools are matched case-insensitively but written in each harness's own
// spelling. Claude has no equivalent for ast_grep/ast_edit (they are omp tools)
// and no `eval`, so those rows are dropped rather than written as a name Claude
// would fail to resolve. A `tools` list where nothing resolves makes Claude Code
// refuse to launch the subagent, so dropping is the safe direction.
// ------------------------------------------------------------------------------
const CLAUDE_TOOL = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  bash: "Bash",
  lsp: "LSP",
  web_search: "WebSearch",
  websearch: "WebSearch",
  webfetch: "WebFetch",
  task: "Agent",
  scout: "Agent",
  notebook: "NotebookEdit",
};

// Model roles are resolved per harness. omp keeps the role indirection, because
// its config.yml defines them and a reroute is one edit. Claude needs a concrete
// alias, so each role maps to the tier its intent implies.
const CLAUDE_MODEL = {
  "@deep": "opus",
  "@slow": "opus",
  "@plan": "opus",
  "@review": "opus",
  "@design": "sonnet",
  "@build": "sonnet",
  "@default": "sonnet",
  "@fast": "haiku",
  "@smol": "haiku",
  "@advisor": "haiku",
  "@commit": "haiku",
  "@work": "sonnet",
};

// Thinking levels are omp's; Claude has `effort` with a different vocabulary.
const CLAUDE_EFFORT = {
  high: "high",
  medium: "medium",
  low: "low",
};

function claudeTools(tools = []) {
  const mapped = [];
  for (const tool of tools) {
    const name = CLAUDE_TOOL[String(tool).toLowerCase()];
    if (name && !mapped.includes(name)) mapped.push(name);
  }
  return mapped;
}

function yamlish(value) {
  const text = String(value ?? "").trim();
  if (!text) return '""';
  // A plain scalar is safe only if nothing in it can be read as YAML syntax. A
  // colon followed by a space starts a mapping, a leading quote or bracket
  // starts a collection, and # starts a comment. Getting this wrong produced a
  // file Claude would skip with only a debug-log line, so the test is inverted:
  // quote unless it is provably plain.
  const plainSafe =
    /^[A-Za-z0-9][A-Za-z0-9 .,;()'/_+-]*$/.test(text) &&
    !/: /.test(text) &&
    !/\s#/.test(text) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(text) &&
    !/^[+-]?\d+(\.\d+)?$/.test(text);
  return plainSafe ? text : JSON.stringify(text);
}

// ------------------------------------------------------------------------------
// omp: the richest target, so it keeps everything the source declares.
// ------------------------------------------------------------------------------
function renderOmp(agent) {
  const lines = ["---", `name: ${agent.name}`, `description: ${yamlish(agent.description)}`];
  if (agent.tools?.length) {
    lines.push("tools:");
    for (const tool of agent.tools) lines.push(`  - ${tool}`);
  }
  if (agent.spawns?.length) {
    lines.push("spawns:");
    for (const spawn of agent.spawns) lines.push(`  - ${spawn}`);
  }
  if (agent.skills?.length) {
    lines.push("autoloadSkills:");
    for (const skill of agent.skills) lines.push(`  - ${skill}`);
  }
  if (agent.model) lines.push(`model: ${yamlish(agent.model)}`);
  if (agent.thinkingLevel) lines.push(`thinkingLevel: ${agent.thinkingLevel}`);
  lines.push("---", "", agent.prompt.trim(), "");
  return lines.join("\n");
}

// ------------------------------------------------------------------------------
// Claude Code: same Markdown shape, different vocabulary.
// ------------------------------------------------------------------------------
function renderClaude(agent) {
  const tools = claudeTools(agent.tools);
  const model = CLAUDE_MODEL[agent.model] ?? "sonnet";
  const effort = CLAUDE_EFFORT[agent.thinkingLevel];
  const lines = [
    "---",
    `name: ${agent.name}`,
    `description: ${yamlish(agent.description)}`,
  ];
  // Omitting `tools` means "every tool a subagent may use", which is wider than
  // the source asked for. Always write the narrowed list.
  lines.push(`tools: ${tools.length ? tools.join(", ") : "Read, Grep, Glob"}`);
  lines.push(`model: ${model}`);
  if (effort) lines.push(`effort: ${effort}`);
  if (agent.skills?.length) {
    // Claude preloads skill content rather than loading it on demand.
    lines.push(`skills: ${agent.skills.join(", ")}`);
  }
  const dropped = (agent.tools ?? []).filter((t) => !CLAUDE_TOOL[String(t).toLowerCase()]);
  const note = dropped.length
    ? `\n<!-- Generated from agents/agents.json. Tools with no Claude equivalent, dropped here: ${dropped.join(", ")}. -->`
    : "\n<!-- Generated from agents/agents.json. Edit that file, then run `node scripts/sync-agents.mjs`. -->";
  lines.push("---", "", agent.prompt.trim(), note, "");
  return lines.join("\n");
}

// ------------------------------------------------------------------------------
// OpenBot: no agent files, but a real import format.
//
// OpenBot reads a .zip at Server settings > Import, described by its own
// `agent-import` resources. The manifest is strict and the whole archive is
// rejected when it is invalid, so this writes the documented shape rather than
// something close to it:
//
//   openbot-import.json
//   agents/<key>/files/INSTRUCTIONS.md   when the instructions exceed 2,000 chars
//
// `description` holds the instructions and is capped at 2,000 characters. The
// roster's prompts run longer than that, so each one is written to
// files/INSTRUCTIONS.md and the description points at it; `files` is copied to
// `imported/` in the agent's workspace on import.
// ------------------------------------------------------------------------------

const OPENBOT_DESCRIPTION_MAX = 2000;

function agentKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function openbotEntry(agent) {
  const key = agentKey(agent.name);
  const instructions = agent.prompt.trim();
  const long = instructions.length > OPENBOT_DESCRIPTION_MAX;
  const entry = {
    key,
    name: agent.name,
    title: (agent.description ?? "").slice(0, 120),
    // The manifest wants instructions here. A long prompt cannot fit, so it
    // names the file and the agent is told to read it.
    description: long
      ? `Your full instructions are in imported/INSTRUCTIONS.md in your workspace. Read that file before your first task, and follow it for every later turn. Summary: ${(agent.description ?? "").slice(0, 900)}`
      : instructions,
    avatar: null,
    skills: [],
    routines: [],
    memories: [],
    files: long ? `agents/${key}/files` : null,
  };
  return { entry, instructions, long };
}

function zipArchive(entries, outFile) {
  // PowerShell's Compress-Archive writes a zip that OpenBot reads, and it exists
  // on every supported Windows box. The staging directory keeps the archive
  // root flat: openbot-import.json has to be at the root, not inside a folder.
  const staging = path.join(os.tmpdir(), `openbot-import-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, content] of Object.entries(entries)) {
    const target = path.join(staging, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(path.dirname(outFile), { recursive: true });
  const ps = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `Compress-Archive -Path '${path.join(staging, "*")}' -DestinationPath '${outFile}' -Force`,
  ];
  const result = spawnSync("pwsh", ps, { encoding: "utf8" });
  rmSync(staging, { recursive: true, force: true });
  if (result.status !== 0) {
    throw new Error(`Compress-Archive failed: ${(result.stderr || "").trim()}`);
  }
}

function syncOpenbot(agents, { out = null } = {}) {
  const entries = {};
  const manifestAgents = [];
  for (const agent of agents) {
    const { entry, instructions, long } = openbotEntry(agent);
    manifestAgents.push(entry);
    if (long) entries[`agents/${entry.key}/files/INSTRUCTIONS.md`] = `${instructions}\n`;
  }
  const manifest = {
    format: "openbot-agent-import",
    version: 1,
    source: { app: "dotfiles-win", exportedAt: new Date().toISOString() },
    agents: manifestAgents,
  };
  entries["openbot-import.json"] = `${JSON.stringify(manifest, null, 2)}\n`;

  const longCount = manifestAgents.filter((a) => a.files).length;
  if (CHECK) {
    console.log(`  would write ${manifestAgents.length} agents (${longCount} with INSTRUCTIONS.md)`);
    return 0;
  }
  const target = out ?? path.join(REPO, "agents", "openbot-import.zip");
  zipArchive(entries, target);
  console.log(`  ${manifestAgents.length} agents, ${longCount} carrying INSTRUCTIONS.md`);
  console.log(`  -> ${target}`);
  console.log("");
  console.log("  Import it in OpenBot: Server settings > Import, then choose that file.");
  return 0;
}

// ------------------------------------------------------------------------------
// Writers
// ------------------------------------------------------------------------------
function writeTree(dir, files) {
  let written = 0;
  mkdirSync(dir, { recursive: true });
  const wanted = new Set(files.map((f) => f.name));
  for (const file of files) {
    const target = path.join(dir, file.name);
    const next = file.content;
    const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (previous === next) continue;
    if (CHECK) {
      console.log(`  drift  ${path.relative(REPO, target)}`);
      continue;
    }
    writeFileSync(target, next);
    written += 1;
  }
  // A file the roster no longer defines is a leftover from an older roster, and
  // leaving it means a deleted agent keeps answering. Only remove files this
  // generator owns: it writes a marker line in every file it creates.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || wanted.has(name)) continue;
    const target = path.join(dir, name);
    const text = readFileSync(target, "utf8");
    if (!text.includes("Generated from agents/agents.json")) continue;
    if (CHECK) {
      console.log(`  stale  ${path.relative(REPO, target)}`);
      continue;
    }
    rmSync(target);
    console.log(`  removed ${path.relative(REPO, target)}`);
  }
  return written;
}

function homeDir(rel) {
  return path.join(os.homedir(), rel);
}

// ------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------
// The harness map sits beside the roster, wherever that turned out to be.
const manifest = JSON.parse(readFileSync(path.join(path.dirname(ROSTER), "harnesses.json"), "utf8"));
const roster = JSON.parse(readFileSync(ROSTER, "utf8"));
const agents = roster.agents ?? [];

if (OPENBOT) {
  process.exit(syncOpenbot(agents));
}

console.log(`${agents.length} agents in agents/agents.json`);

const ompDir = homeDir(manifest.harnesses.omp.dir);
const claudeDir = homeDir(manifest.harnesses.claude.dir);

console.log(`\nomp -> ${ompDir}`);
const ompWritten = writeTree(ompDir, agents.map((agent) => ({ name: `${agent.name}.md`, content: renderOmp(agent) })));
console.log(CHECK ? "  (check only)" : `  ${ompWritten} file(s) written`);

console.log(`\nClaude Code -> ${claudeDir}`);
const claudeWritten = writeTree(claudeDir, agents.map((agent) => ({ name: `${agent.name}.md`, content: renderClaude(agent) })));
console.log(CHECK ? "  (check only)" : `  ${claudeWritten} file(s) written`);

console.log("\npi, Codex and T3 Code need no files: none of them has a custom-agent registry.");
console.log("OpenBot takes an import archive instead: run with --openbot to build it.");
