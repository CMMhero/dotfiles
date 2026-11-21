// ==============================================================================
// usage-env.mjs - find command line tools the way a terminal would.
//
// The dashboard often runs where the shell's PATH is not: a systemd user unit, a
// Windows scheduled task, an ssh command. The tools it shells into (atuin, agy,
// claude, codex, cmd) are usually installed by mise or vite+, which put shims in
// folders only an activated shell knows about, so a plain spawn answers ENOENT
// and the page says "not installed" for a tool that is. These helpers add the
// usual folders to PATH and, failing that, ask mise where the tool is.
// ==============================================================================

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Folders that hold mise, vite+, cargo, brew and scoop installs, newest convention first.
export function extraToolDirs(home = os.homedir(), env = process.env) {
  const dirs = [
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "vite-plus", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".atuin", "bin"),
    path.join(home, ".bun", "bin"),
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const local = env.LOCALAPPDATA;
  if (local) dirs.push(path.join(local, "mise", "shims"), path.join(local, "Microsoft", "WinGet", "Links"), path.join(local, "vite-plus", "bin"));
  dirs.push(path.join(home, "scoop", "shims"));
  return dirs;
}

// env with those folders appended after the existing PATH. The key keeps its own
// spelling ("Path" on Windows) so the child does not see two.
export function toolEnv(home = os.homedir(), env = process.env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const have = new Set((env[key] ?? "").split(path.delimiter).filter(Boolean));
  const added = extraToolDirs(home, env).filter((d) => !have.has(d));
  return { ...env, [key]: [env[key] ?? "", ...added].filter(Boolean).join(path.delimiter) };
}

const found = new Map(); // name -> { cmd, env } once a lookup has succeeded

/**
 * { cmd, env } to run `name` with, or null when it cannot be found. Tries PATH
 * plus the usual folders, then `mise which`. A success is remembered; a miss is
 * looked up again next time, because the user may install the tool meanwhile.
 */
export function findTool(name, { home = os.homedir(), env = process.env } = {}) {
  if (found.has(name)) return found.get(name);
  const withDirs = toolEnv(home, env);
  const probe = (cmd) => spawnSync(cmd, ["--version"], { env: withDirs, timeout: 10_000, windowsHide: true, stdio: "ignore" });
  let hit = null;
  const direct = probe(name);
  if (direct.error?.code !== "ENOENT") hit = { cmd: name, env: withDirs };
  else {
    const mise = spawnSync("mise", ["which", name], { env: withDirs, encoding: "utf8", timeout: 10_000, windowsHide: true });
    const located = mise.status === 0 ? mise.stdout.trim().split(/\r?\n/)[0] : "";
    if (located && probe(located).error?.code !== "ENOENT") hit = { cmd: located, env: withDirs };
  }
  if (hit) found.set(name, hit);
  return hit;
}
