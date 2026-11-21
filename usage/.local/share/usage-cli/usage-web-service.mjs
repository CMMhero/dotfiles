// ==============================================================================
// usage-web-service.mjs - keep `usage web` running in the background.
//
//   usage web install | uninstall | start | stop | restart | status
//
// One verb set, two backends, so the same words work on both machines:
//   win32  the UsageWeb scheduled task (web-usage.ps1), started at logon
//   linux  a systemd user service, usage-web.service, started with the user
//          manager and restarted if it exits
// Anything else, or a Linux box with no systemd user session, gets a message
// that says what to run by hand instead. The server only listens on loopback.
// ==============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const WEB_ACTIONS = ["install", "uninstall", "start", "stop", "restart", "status"];
const UNIT = "usage-web.service";
const DEFAULT_PORT = 8787;

const unitDir = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
const unitFile = (env) => path.join(unitDir(env), UNIT);

function systemctl(...args) {
  return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
}

const hasSystemdUser = () => systemctl("show-environment").status === 0;

// When this file runs from the vendored copy, ExecStart is the launcher in
// ~/.local/bin: it resolves node itself (vp or mise), so a node upgrade never
// leaves the unit pointing at a deleted path. Run from anywhere else (the
// dotfiles-win checkout), the launcher would start a different copy of the code,
// so the unit names this node and this usage.mjs instead.
export function execStart({ scriptDir, port, home = os.homedir(), exists = existsSync, node = process.execPath, env = process.env, real = realpathSync }) {
  const launcher = path.join(home, ".local", "bin", "usage");
  const vendored = path.join(env.USAGE_CLI_DIR || path.join(home, ".local", "share", "usage-cli"), "usage.mjs");
  // stow links the vendored files one by one, so this file's own directory is the
  // repo copy; the launcher runs "ours" when its usage.mjs resolves to the same file.
  const ours = path.join(scriptDir, "usage.mjs");
  const sameCopy = (() => { try { return real(vendored) === real(ours); } catch { return false; } })();
  const base = exists(launcher) && sameCopy ? [launcher] : [node, ours];
  return [...base, "web", "--no-open", "--port", String(port)].join(" ");
}

export function renderUnit(opts) {
  return `[Unit]
Description=usage web dashboard (loopback only)
After=network-online.target

[Service]
ExecStart=${execStart(opts)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// The port the installed unit serves on, so `status` and `restart` agree with it.
export function installedPort(env = process.env) {
  try {
    return Number(/--port (\d+)/.exec(readFileSync(unitFile(env), "utf8"))?.[1]) || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 800 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function linux(action, { scriptDir, port, env = process.env }) {
  if (!hasSystemdUser()) {
    console.error("usage web " + action + ": no systemd user session here. Run `usage web --no-open` in a herdr pane or a nohup shell instead.");
    return 1;
  }
  const file = unitFile(env);
  if (action === "install") {
    mkdirSync(unitDir(env), { recursive: true });
    writeFileSync(file, renderUnit({ scriptDir, port: port || DEFAULT_PORT }));
    systemctl("daemon-reload");
    // restart, not `enable --now`: installing again with another port must replace a
    // running instance, and `--now` leaves an already-active unit untouched.
    systemctl("enable", UNIT);
    const result = systemctl("restart", UNIT);
    if (result.status !== 0) { console.error(result.stderr.trim()); return 1; }
    console.log(`Installed ${UNIT} (starts with your user session, restarts if it stops) and started it.`);
    console.log(`  http://127.0.0.1:${port || DEFAULT_PORT}`);
    // The user manager normally stops at logout. linger keeps the dashboard up.
    const linger = spawnSync("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"], { encoding: "utf8" });
    if (linger.status === 0 && linger.stdout.trim() !== "yes") console.log(`  tip: sudo loginctl enable-linger ${os.userInfo().username}   (keep it running after logout)`);
    return 0;
  }
  if (action === "uninstall") {
    systemctl("disable", "--now", UNIT);
    rmSync(file, { force: true });
    systemctl("daemon-reload");
    console.log(`Removed ${UNIT}.`);
    return 0;
  }
  if (!existsSync(file)) { console.error("The service is not installed. Run: usage web install"); return 1; }
  if (action === "status") {
    const state = systemctl("is-active", UNIT).stdout.trim() || "unknown";
    const p = installedPort(env);
    console.log(`${UNIT}: ${state}, ${(await portAnswers(p)) ? `answering on http://127.0.0.1:${p}` : `not answering on port ${p}`}`);
    return state === "active" ? 0 : 1;
  }
  const result = systemctl(action, UNIT);
  if (result.status !== 0) { console.error(result.stderr.trim()); return 1; }
  console.log(`${action === "stop" ? "Stopped" : "Started"}.${action === "stop" ? "" : ` http://127.0.0.1:${installedPort(env)}`}`);
  return 0;
}

function windows(action, { scriptDir, port }) {
  const script = path.join(scriptDir, "web-usage.ps1");
  if (!existsSync(script)) {
    console.error(`usage web ${action}: web-usage.ps1 not found next to usage.mjs (${script}).`);
    return 1;
  }
  const flag = { install: "-Install", uninstall: "-Uninstall", start: "-Start", stop: "-Stop", restart: "-Restart", status: "-Status" }[action];
  const args = ["-NoLogo", "-NoProfile", "-File", script, flag];
  if (port) args.push("-Port", String(port));
  return spawnSync("pwsh", args, { stdio: "inherit" }).status ?? 1;
}

export async function manageWeb(action, { scriptDir, port, platform = process.platform } = {}) {
  if (platform === "win32") return windows(action, { scriptDir, port });
  if (platform === "linux") return linux(action, { scriptDir, port });
  console.error(`usage web ${action}: no background service for ${platform}. Run \`usage web --no-open\` yourself.`);
  return 1;
}
