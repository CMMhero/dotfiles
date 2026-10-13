# Global Agent Instructions – CMM

> Single source of truth for every AI agent/harness I use (Claude Code, Cline, Codebuff/Codex, OpenCode, Cursor, Gemini CLI, Windsurf…). Per-harness files (CLAUDE.md, GEMINI.md, .codex/AGENTS.md, .clinerules…) reference this so instructions stay in one place.

## How to work

- Precise, minimal, typed code. Clean + well-named over boilerplate.
- Read surrounding context before proposing a fix; don't guess.
- Give a short plan before large edits, then execute.
- Small reviewable changes over sweeping rewrites unless asked otherwise.
- Real-time, API integrations, and DB-backed systems are bread-and-butter — keep that lens.
- Follow repo conventions; respect existing per-project AGENTS.md/CLAUDE.md/README.
- **When writing or giving any output** (docs, READMEs, PRDs, prose, summaries, explanations) **always run it through the unslop skill** so it reads natural and human — no AI writing patterns.
- My prompts are short and imperative — answer in kind: act, don't lecture. Follow-ups are iterative ("now X broke") — re-read the thread, fix forward, never restart from zero.
- Bug reports come with hard constraints; treat every stated constraint as a requirement (e.g. a sticky navbar "needs background, cannot be transparent"). If a constraint makes the ideal outcome impossible, say so rather than silently dropping it.
- For production tools, "works" means reliable + fast + portable across hardware. Harden, don't just fix the repro; prefer eliminating the fragile mechanism over patching around it, and make the change hold under repeated runs.
- When showing integration/API work, include a runnable usage example or test endpoint — "how does the usage look" is a standing request.
- Expect cross-repo consistency checks ("does the dashboard need the same model/queue as the SSE side?"). When a pattern already exists in a sibling repo, mirror it unless there's a reason not to, and say why.
- Interrogate edge cases explicitly — especially offline/ordering/duplication (queued events, double-registration, expiry-while-offline). Prove no event or log line is lost, and standardize log shape when touching logging.

## Terminal & environment

- Shell: **PowerShell** on Windows, **fish** on Linux/WSL. Windows runs `CMM.profile.ps1` (chezmoi-managed, a 1:1 port of the WSL fish config; works on 5.1 and 7+). WSL/Linux runs fish as the login shell: `conf.d/env.fish` (PATH, tool activation, exported vars — every fish process) + `config.fish` (prompt, bindings, aliases — interactive only, exits early otherwise). nushell is retired from daily flow.
- Terminal: WezTerm (WebGpu), Catppuccin Macchiato, Acrylic backdrop at 0.75 opacity, 144 FPS max/animation, GeistMono NFP fallback chain (GeistMono Nerd Font Mono, JetBrains Mono, Symbols Nerd Font Mono). Launches `pwsh -NoLogo` by default; the `WSL:Ubuntu` domain exists but is not the default.
- Prompt/history/keys: Starship prompt; atuin history (Ctrl-R); fzf Ctrl-T file picker and Alt-C directory picker (fish vendors key-bindings.fish into conf.d; PowerShell reimplements both against PSReadLine).
- Home is `~` on both machines; this file is shared between Windows and WSL, so every path here is `~`-relative unless the line names a platform.
- Projects live in `~/Code/<project>` on Windows and `~/code/<project>` on WSL.
- Dotfiles live in two repos, one per platform: Windows → **chezmoi** source `~/dotfiles-win`, deployed with `chezmoi apply`; Linux/WSL → **GNU stow** from `~/dotfiles` (packages per install.sh; omp/pi/fresh/superfile linked file-by-file, never stowed whole). Example (Windows): edit `readonly_documents/PowerShell/CMM.profile.ps1`, then `chezmoi apply` → `~/Documents/PowerShell/CMM.profile.ps1`. Exceptions — edit live, never track: nushell `config.nu`/`env.nu`, Raycast DB, and every T3 Code file except the two managed ones. The chezmoi rule under Tooling applies to everything else managed.
- Aliases both shells share (use plain commands in scripts; fish guards with `command -q`, PowerShell with `Get-Command`):
  - nav: cd/cdi (zoxide), .. / ... / .... to go up; h = history
  - list: eza with `--icons=auto --group-directories-first` — ls shows all (`-aF`); l/la slim (`--no-filesize --no-permissions --no-user`); ll adds `--git`; tree/dtree prune `node_modules` + `.git`
  - open: c / c. = zed (falls back to $EDITOR when zed is absent); e / e. / explorer = FilePilot, falling back to explorer.exe
  - git: g, ga (add .), gc (commit -m), gcl, gp, gpl, gst (short), gd (diff), gl (log --oneline --graph --decorate), gco, gb, gpo, lg (lazygit); gh-create = private repo + push + browse
  - view/search: cat (+bcat on Windows) = bat; find = fd; grep = rg --color=auto; vim/nvim = fresh ($EDITOR); ff = fastfetch; btop/htop/top = btop4win
  - misc: please/pls = sudo; ip = ifconfig.me; reload re-execs the shell; cls = clear
  - Windows-only: update → upd (runs update.ps1 via the chezmoi source path); mise plain `activate`, no shims; vp shortcuts vpi/vpa/vpad/vpd/vpb/vpv/vpt/vpc/vpf/vpl/vpcr
  - fish-only: du/df → dust/duf abbreviations (+ du-real/df-real escapes); add → `mise use -g`; pncr = `vp create --editor zed --package-manager pnpm`
- Node/package: **vp-first — never raw npm/npx/bun** unless the project demands it. In both shells npm/npx are functions dispatching to vite+: install → `vp install`, install \<pkg\> → `vp add`, uninstall → `vp remove`, update → `vp update`, run → `vp run`, exec → `vpx`, plain npx → `vpx`. An unmapped npm subcommand errors with the mapping instead of guessing. Escape hatches `npm-real`/`npx-real` hit the real binaries (PowerShell via `npm.cmd`/`npx.cmd`, fish via `command`). pnpm/node themselves come from the vite+ runtime. vp shortcuts: vpi/vpa/vpad/vpd/vpb/vpv/vpt/vpc/vpf/vpl/vpcr. `skills` is a wrapper over vpx with global + agent + auto-yes defaults, and `npx skills` routes into it.
- Python: use **uv** — `uv add` / `uv run` / `uv sync` / `uvx`. Manage project deps and venvs with uv, not raw pip/venv.

## Tooling

- **Dotfiles / config edits go through chezmoi on Windows, GNU stow on Linux/WSL.** Windows dotfiles live in the chezmoi source at `~/dotfiles-win` and are applied to the live paths with `chezmoi apply`; WSL/Linux configs live in `~/dotfiles` packages and deploy via that repo's `install.sh` (stow + file-by-file linkers for omp/pi/fresh/superfile). When I ask you to change a config file (PowerShell `CMM.profile.ps1`, `.gitconfig`, `.wezterm.lua`, atuin, starship, btop, etc.):
  1. Check if it's already managed: `chezmoi managed` / `chezmoi status` (Windows) or the `~/dotfiles` package list (WSL).
  2. If it isn't managed yet: `chezmoi add <file>` first, so it enters the source dir (Windows).
  3. Edit the **source copy** in `~/dotfiles-win` (that's the file you change — e.g. `readonly_documents/PowerShell/CMM.profile.ps1` for `~/Documents/PowerShell/CMM.profile.ps1`), never the live file directly.
  4. Run `chezmoi apply` to push the change live, then verify (`chezmoi status` clean / `chezmoi diff` empty).
- Editor: **Zed** ($EDITOR is fresh in the terminal). WezTerm + PowerShell workflow.
- Use project's own linter/formatter (Biome, ESLint, Prettier, rustfmt, etc.) — match existing config, don't add a new one.
- **Herdr** (terminal multiplexer) is the default way to run, watch, and coordinate any work that isn't a one-liner in the current shell. It organizes terminals into workspaces (`w1`), tabs (`w1:t1`), and panes (`w1:p1`), recognizes the coding agents running inside panes, and exposes everything through the `herdr` CLI (drive it via the **herdr** skill). Reach for it to parallelize tasks, run servers/tests/builds/watch-loops, or pull output from another pane — don't do workarounds when Herdr fits.
  - Only inspect/control Herdr when running *inside* a Herdr-managed pane: require `HERDR_ENV=1`. If that check fails, say you're not inside Herdr and stop; don't drive an active session from outside.
  - Learn syntax from the installed binary (the CLI is the authority): `herdr agent`, `herdr pane`, `herdr workspace`, `herdr tab`, `herdr worktree`, `herdr terminal`, `herdr notification`, `herdr session`. Most control commands return JSON — parse IDs from those responses instead of predicting or re-deriving them.
  - Layout & panes: create a sibling pane with `herdr pane split --current --direction right --cwd "$PWD" --no-focus`, read the new pane ID from `.result.pane.pane_id`, then run a command with `herdr pane run <pane-id> "cmd"`, wait for output with `herdr pane wait-output <pane-id> --match "text"` (literal) or `--regex <pattern>`, and read it back with `herdr pane read <pane-id> --source recent-unwrapped --lines 120`. Pick the read source to match the task: `visible`, `recent`, `recent-unwrapped` (prefer for logs/transcripts), or `detection`.
  - Agents: `herdr agent start <name>`, `herdr agent prompt <name> --wait ...`, `herdr agent wait <name> --until blocked|done|...`, `herdr agent get <name>`, `herdr agent read <name>`, `herdr agent send-keys <name> esc|ctrl+c`. Understand the lifecycle states: `idle`, `working`, `blocked`, `done`, `unknown`. Agent commands accept a unique live agent name or the pane ID hosting it — not terminal IDs or bare agent-kind labels.
  - Safety & coordination: use `--no-focus` for background work unless the user asked to switch context; target via `--current`, an explicit pane ID, or a unique agent name. Close only panes/workspaces/tabs/sessions you created unless the user asked. Never kill the main Herdr process nor run `herdr server stop` from an active session without explicit intent. After an update, check `herdr status` before relying on new server features.
- **Hunk** is the terminal diff reviewer for agent-authored changesets — the preferred way to hand diffs and history to the user. Rather than dumping raw `git` output, show them through Hunk:
  - `hunk diff` — working tree incl. untracked; `hunk diff --staged`; `hunk diff <from> <to>` (two revisions); `hunk diff --files <left> <right>` (two concrete files). Restrict scope with `hunk diff [target] -- <pathspec...>`.
  - `hunk show [target]` — last commit or a given target; `hunk log [target]` — history browser; `hunk stash show <ref>`; `hunk patch <file>` (a patch file or stdin).
  - Useful flags: `--mode auto|split|unified`, `--line-numbers`, `--sidebar`, `--theme <theme>`, `--transparent-bg`, `--agent-context <path>` (JSON sidecar with your rationale), `--no-watch`.
  - Run `hunk <command> --help` for command-specific syntax and options.

- CLI toolchain is **mise** (`~/.config/mise/config.toml`, chezmoi-managed, everything `latest`): atuin, bat, eza, fd, fastfetch, fzf, lazygit, ripgrep, starship, zoxide — plus the agent CLIs **pi**, **hunk**, **oh-my-pi** (binary `omp`), **herdr**. `opencode` is an npm global instead (`vp i -g @opencode/cli`; vite+ owns package managers). winget owns Git, PowerShell, chezmoi, mise, Zed, WezTerm, fresh ($EDITOR of choice), btop4win, Helium (default browser), ShareX, FilePilot, Quick Share, Spotify, Chrome Remote Desktop; Raycast is msstore-only. Deliberately absent: delta, dust, duf, glow, jq, navi, pastel, procs, superfile, tealdeer, television, uv (unused here).
- Daily agent models: Codex `gpt-5.6-luna` (reasoning medium); T3 favorites codex/`gpt-5.6-luna` and claudeAgent/`claude-opus-5`, default provider opencode/`space-bunny-free`.
- **T3 Code** is my agent IDE: nightly from GitHub releases (NOT winget), lives in `~/.t3`. Providers on: opencode + codex. Its `keybindings.json` and `settings.json` rewrite on exit and stay untracked; `client-settings.json` and `desktop-settings.json` are chezmoi-managed (edit the source copy, never the live file).

## Machines & remotes

- **WSL (Ubuntu, user cmmhero, home /home/cmmhero)** is the Linux half of this box. Its shell is **fish** (set by the WSL repo's install.sh via chsh), not nushell. `.wslconfig` keeps the distro and the VM alive (`instanceIdleTimeout=-1`, `vmIdleTimeout=-1`), forwards localhost so sshd is reachable at 127.0.0.1:2222, and enables sparseVhd + autoProxy.
- **SSH aliases** (`~/.ssh/config`, chezmoi-managed from `dot_ssh/config` in the source repo; keys committed plaintext by design): `linux` = WSL over 127.0.0.1:2222 (user cmmhero, id_ed25519), `main` = 129.225.6.168 (user ubuntu, cmmhero-main.key), `dev` = 168.110.216.90 (user ubuntu, cmmhero-dev.key — the dev VPS). The old `vps` alias is dead (domain stopped resolving).
- **Zed remote servers** (`ssh_connections` in chezmoi-managed Zed settings): `wsl` (host linux), `main`, `dev vps` (host dev) — user/port/key all inherit from the SSH aliases above. Host-only entries on purpose: they prompt for a folder in the Remote Projects dialog.
- **Herdr remote** (`manage_ssh_config = true`) drives the `linux` machine over that same 127.0.0.1:2222 forward; the HERDR_ENV=1 and no-focus/background rules apply there exactly as locally.

## Code style (general)

- TypeScript/JS: typed, concise, no needless abstraction; composition + explicit variants over boolean props / renderX props.
- React: compound components + composition; lift state into providers for shared siblings.
- Backend: small APIs; use project framework (Express, Laravel, Next+nginx, etc.).
- Databases in use: PostgreSQL, MySQL, MongoDB, Firebase.

## UI stack

- **Tailwind CSS** for styling; **shadcn/ui** for components (or the same component conventions).
- Follow the design language already in the project; match existing Tailwind config, tokens, and shadcn components — don't introduce a parallel styling system.

## React / Next.js structure

- Use **reusable components**; extract anything used more than once (or likely to be) into a component.
- Keep folders clear and role-based. Typical layout for React/Next.js:
  - `pages/` (or `app/`), `components/`, `utils/` (or `lib/`), `data/`, `types/`, `hooks/`, `styles/`, `public/`, `tests/`.
- Name files by responsibility; group related items together; keep imports organized.

## Project scaffolding

- When starting a new project, feature, or repo, **create the whole folder/file structure up front first** — including empty folders — so the layout is established and reusable later.
  - For React/Next.js: `pages/`, `components/`, `utils/`, `data/`, `types/`, `hooks/`, etc.
  - Mirrors the "empty folder" step so future work has obvious homes.
- **Build web apps with Vite+ (`vp`)** — my preferred way to scaffold, build, and manage web apps. `vp` is the one-tool CLI for the web (Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, plus runtime/package-manager management; https://viteplus.dev). Use `vp create` to scaffold a new app, `vp migrate` to move an existing Vite project onto Vite+, and day-to-day: `vp install`, `vp dev`, `vp check`, `vp test`, `vp build`. Reach for Vite+ first when standing up a web app.
- **PRD & README are always required — never wait to be asked.** Apply to **all** projects, new or existing, with no exception:
  - New project/idea/repo → create a `PRD.md` and `README.md` up front capturing concept, feature list, architecture, and implementation notes.
  - Existing project → if a `PRD.md`/`README.md` doesn't already exist, create them as part of the work.
  - Every change/feature → **update** the PRD and README in the same pass, so context and implementation notes never drift out of date.
  - Treat PRD + README as part of "done"; don't leave a task complete without them reflecting the current state.
- Prefer **scripts** for tasks that are repetitive or fit automation (build, seed, sync, formatting, etc.).

## Committing

- **Semantic commit messages** (Conventional Commits): e.g. `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `perf:`.
  - Concise subject line; add a **description/body** when the change needs context (why + what).
  - Example: `feat: add discord presence endpoint` with a body explaining behavior.
- **Never** commit directly to `main` — always branch off main, and merge via PR or after review. Keep `main` clean and green.
- **Never** add "Co-Authored-By", "Generated with/by AI agent", or similar authorship lines. Commits are clean and human-authored.
- Run relevant tests/build after changes if the project has them.

## Global note & harness wiring

- When in doubt, follow the specific repo I'm in.
- **`~/AGENTS.md` is the single source of truth.** The same file is deployed on both machines — by chezmoi on Windows (`AGENTS.md` in the source repo), by GNU Stow on WSL (`agents` package) — so every path in it stays `~`-relative. Edit the source copy, never a live one; the harness files below are pointers, not copies, so they never drift.
  - Claude Code → `~/.claude/CLAUDE.md` (`@~/AGENTS.md` include)
  - Codex → `~/.codex/AGENTS.md` ("Read and follow")
  - Oh My Pi (pi) → `~/.pi/agent/AGENTS.md` ("Read and follow")
  - oh-my-pi (omp) → `~/.omp/agent/AGENTS.md` ("Read and follow")
  - Cline → `~/.clinerules/global.md` ("Read and follow")
  - Cursor → `~/.cursorrules` (legacy file; no `.cursor/AGENTS.md` yet)
  - Not wired yet (no pointer file — create one when setting the harness up): Gemini CLI (`~/.gemini/GEMINI.md`), Windsurf (`~/.windsurf/global_rules.md`)
- When setting up a new harness, add its global-file pointer to the list above so the map stays current.