# dotfiles

Modular dotfiles managed with **GNU Stow**, with `install.sh` / `uninstall.sh` for a zero-to-hero setup or a full reset on fresh Linux / Ubuntu installations.

---

## What's Included

- **Shell (managed)**: Fish (`~/.config/fish`), installed as a **Homebrew formula**, not from apt — brew holds it at a fixed path (`/home/linuxbrew/.linuxbrew/bin/fish`) so upgrading it never breaks `chsh` or herdr's `default_shell`
- **Package managers**: `apt` for the base system, **Homebrew / Linuxbrew** for `fish`, `mise`, `opencode` and `vite-plus`, `mise` for the rest, and **vite+** for Node.js + npm/pnpm/yarn/bun
- **CLI Tools (via `mise`)**: `atuin`, `bat`, `btop`, `chafa`, `delta`, `eza`, `fastfetch`, `fd`, `fzf`, `gh`, `go`, `herdr`, `hunk`, `jq`, `lazygit`, `neovim`, `pi`, `ripgrep`, `rust`, `starship`, `superfile`, `tealdeer`, `uv`, `zoxide` — plus `llmfit`, `models` and `oh-my-pi`. `node`, `pnpm` and `vite+` are **not** here; see below
- **Python**: `uv` (via `mise`)
- **Terminal Workspace & Emulators**:
  - `herdr` (`~/.config/herdr/config.toml`) with custom keybindings, tabs, and Catppuccin theme
  - `wezterm` — **Windows-only**. `wezterm/.wezterm.lua` is kept in the repo for reference (WSL domain, pwsh `default_prog`, Acrylic backdrop) but is **not stowed** and wezterm is **not installed** on Linux.
- **Editor**: `fresh-editor` (`~/.config/fresh`) with the Catppuccin theme package, the `color-highlighter` plugin, a `dotfiles-fresh-language` grammar, vi mode enabled at startup, and a **"Toggle vi mode"** command in the palette (Ctrl+P)
- **mise config (managed)**: [`mise/.config/mise/config.toml`](mise/.config/mise/config.toml) is stowed to `~/.config/mise/config.toml` and is the single source of truth for what gets installed — `install.sh` runs a bare `mise install` and declares no tool list of its own. Everything is pinned to `latest`. Add a tool by adding a line here and re-running; note that removing a line does **not** uninstall the tool (see below)
- **Node.js & Package Managers**: owned by **vite+**, *not* mise. `mise/config.toml` declares neither `node` nor `pnpm`. vite+'s stowed config sets `nodeShimMode` and all four `packageManagerShimModes` (`npm`, `pnpm`, `yarn`, `bun`) to `managed` — the only other valid value is `system_first`, which is what it used to be set to. `vp env current` should report `Mode managed` for both
  - This needs vite+'s **global CLI**, which is a Homebrew formula here. It is not interchangeable with the `npm:vite-plus` mise tool: that one is the project-local package and has no `vp env` subcommand at all, so a mise-installed vite-plus cannot manage a runtime. The global CLI is a superset, adding `env`, `node`, `dlx` and package management. install.sh also removes `npm:vite-plus` from mise so its stale `vp` shim cannot shadow brew's
  - fish sources vite+'s own generated `~/.config/vite-plus/env.fish`, which prepends the shim dir so `node` resolves through vite+ and wraps `vp` for `vp env use`. That file is machine state, not stowed
  - `VP_HOME` (`~/.local/share/vite-plus`, holding the downloaded runtimes, shims and generated env files) is **not** managed
- **Theme**: Catppuccin Macchiato is the source of truth (defined once in `wezterm/.wezterm.lua`). `bat` uses it directly (`bat/.config/bat/config`), `fzf` gets an equivalent palette via `fish/.config/fish/conf.d/catppuccin.fish`, and `omp` uses its built-in `dark-catppuccin` — that one is **Mocha**-flavoured, since omp ships no Macchiato and `grep -c macchiato` over its dist returns 0.
- **AI Coding Agents**:
  - `omp` (via `mise` as `github:can1357/oh-my-pi`) — **narrowly** stowed: only `~/.omp/agent/config.yml`, `~/.omp/plugins/package.json` and `~/.omp/agent/extensions/opencode-zen-fix.ts`. Everything else in `~/.omp` (sessions, run, logs, cache, `stats.db`, `install-id`, plugin `node_modules`) stays per-machine.
  - `opencode` — installed as a **Homebrew formula**, not a `mise` tool. `mise` tracked it behind the `aqua` backend, which pins an old release with no channel for the current one; brew ships a bottle and tracks upstream itself. Config **not** managed
  - `pi` (`aqua:earendil-works/pi`) — installed via `mise`, config **not** managed
- **Cheatsheets**: three tools, wired to different sources
  - **`tealdeer`** (`tldr`) — config stowed. Its page cache (`~/.cache/tealdeer/tldr-pages`, ~7400 pages) is machine state and is not managed
  - **`navi`** — [config](navi/.config/navi/config.yaml) stowed, and it sets `client.tealdeer: true`, which is load-bearing. Without it `navi --tldr <q>` shells out to `tldr <q> --markdown` and dies, because the installed `tldr` is tealdeer, which has no `--markdown` (`error: unexpected argument '--markdown' found`). tealdeer's equivalent is `-r/--raw`, and the flag makes navi call tealdeer correctly. Cheatsheet repos are cloned into `~/.local/share/navi/cheats/<owner>__<repo>` — **`navi repo add` is broken in 2.24.0** and is not used (it clones fine, then fails its copy step with `the source path is neither a regular file nor a symlink to a regular file`, because `std::fs::copy` cannot copy a directory). That directory is machine state, not stowed
  - **`television`** (`tv`) — config stowed, plus [a `tldr` channel](television/.config/television/cable/tldr.toml) that reads the tealdeer cache. `tv update-channels` ships no tldr channel, so this one is ours; it lists page names from the cache and previews the selected page. `install.sh` runs `tv update-channels`, which leaves existing channel files alone without `--force`. Upstream's `cable/` files are machine state and are not managed
- **`du` → `dust`, `df` → `duf`**: `abbr`, with `du-real` / `df-real` escape hatches. Overriding `df` is the riskier of the two, since `df`-output-parsing scripts will break on `duf`
- **Skills**: not managed. `~/.agents/skills` and `~/skills-lock.json` stay per-machine, as do the `opencode/` / `pi/` / `omp/` skill dirs. Install with the `skills` wrapper (`pnpm dlx`, global by default): `skills add <pkg>`.

---

## Quick Start on a Fresh Ubuntu Machine

One-liner (clones or pulls the repo, then installs everything):

```bash
curl -fsSL https://raw.githubusercontent.com/CMMhero/dotfiles/main/install.sh | bash
```

Or manually:

```bash
if [[ ! -d "$HOME/dotfiles" ]]; then
  git clone https://github.com/CMMhero/dotfiles.git "$HOME/dotfiles"
else
  cd "$HOME/dotfiles" && git pull --ff-only
fi

cd "$HOME/dotfiles" || exit 1
./install.sh
```

The script will, in order:
1. Install the apt base essentials: `git` and `stow`.
   This runs **before** the clone, because the `curl | bash` entry point may run
   on a machine where nothing is installed yet -- which is why the clone cannot
   come first.
2. Clone the repository (or pull, if it already exists).
3. Install **Homebrew (Linuxbrew)** if it is missing, then install any missing
   `fish` / `mise` / `opencode` / `vite-plus` formulas. `mise` is deliberately no
   longer bootstrapped with `curl https://mise.run | sh` — that dropped a second
   `mise` into `~/.local/bin` that could shadow or be shadowed by brew's copy
   depending on PATH order, and `uninstall.sh` then had to delete it by hand. One
   `mise`, owned by brew. `opencode` is a formula rather than a `mise` tool so it
   tracks upstream instead of sitting on a pinned old release.
4. Install every tool the [mise config](mise/.config/mise/config.toml) declares, with a
   bare `mise install`. The config is the **single source of truth** — there is no tool
   list in the scripts, because a hardcoded copy had already drifted from it
   (`llmfit` and `models` had been deleted from the script while the config still
   declared them, so a fresh machine would have installed a config promising tools the
   installer never fetched). The config is linked *before* `mise install` runs, not by
   the later stow step, so the install never reads an absent config.

   This step runs under `--config-only` too, unlike the package downloads around it.
   `upd dotfiles` is `git pull` then `install.sh --config-only`, and since `upd` runs
   its own mise step *before* the pull, `mise install` is the only thing that can pick
   up a tool upstream had just added — `mise upgrade` only moves versions that already
   exist.
5. Hand Node.js and the package managers to vite+: `vp env setup --refresh` creates the
   `node`/`npm`/`pnpm`/`yarn`/`bun` shims, and `vp env on` records managed mode. Both
   are required — without the first there is no `node` or `pnpm` at all now that mise
   no longer supplies them, and vite+ only records managed mode once it is asked.

**Deleting a line from the config does not uninstall anything.** `mise install` only
adds, and the old shim keeps working — after removing the `fzf` entry, `fzf --version`
still answered `0.74.4` while `mise which fzf` reported it inactive. The entry only
stops the tool being tracked and updated; to actually drop it use `mise uninstall
<tool>`, or `mise prune`.

**If the config is missing, the install still completes.** The usual cause is a
checkout older than the `mise` package, and `./install.sh` deliberately does not
pull — so a stale tree is the expected way to hit it. In that case `install.sh`
warns, points at `git -C ~/dotfiles pull`, and skips only mise's tools. Every other
config, the login shell and the fish handoff still happen.

Steps 3 and 4 run **non-interactive and auto-accepting** — brew with
`NONINTERACTIVE=1`, `HOMEBREW_NO_AUTO_UPDATE=1` and `HOMEBREW_NO_ASK=1`, mise with
`MISE_YES=1`. A `sudo` password prompt is left intact on purpose.

The three brew variables are not interchangeable, and one of them is not optional.
Under `curl … | bash` there is no TTY, so mise's trust prompt would hang with nobody
to answer it — that is what `MISE_YES=1` is for. Homebrew's confirmation is the
opposite case: it checks only whether stdin and stdout are a TTY and consults no
environment variable, so it never hangs headless but blocks whenever a terminal *is*
attached. Measured, from a real terminal with `NONINTERACTIVE=1` set:

```
==> Would upgrade 2 outdated packages
==> Do you want to proceed with the upgrade? [y/n]
```

`HOMEBREW_NO_ASK=1` is the switch for it ("Ask mode is the default unless
`$HOMEBREW_NO_ASK` is set") and is set in `fish/.config/fish/config.fish`, so a bare
interactive `brew upgrade` is covered too, not just the calls `install.sh` makes.

6. Point pnpm's global bin dir at `~/.local/bin`.
7. Back up conflicting files to `~/.dotfiles_backup/<timestamp>/`.
8. Stow the 13 config packages, then link `fresh` / `superfile` by walking them
   and `omp` from a fixed three-file list — stow would link those app
   directories whole, and anything the tools write there would land in the repo.
9. Install omp's plugins with `pnpm`, refresh fresh's package registry, and
   regenerate its API types.
10. Set fish as the default login shell.
11. Syntax-check every deployed `*.fish` file, then hand off to a fresh fish so
    the new config is live. The handoff is an EXIT trap, so it still runs if an
    earlier step aborts under `set -e`.

Re-running is safe. `./install.sh --config-only` deploys only the configs, which
is what `upd dotfiles` uses so it does not repeat the package work.

---

## Managing Stow Packages Manually

From within `~/dotfiles`:

```bash
# Stow all managed packages to $HOME (fresh / superfile / omp / wezterm excluded)
stow -v -R -t ~ fish git mise starship atuin bat btop fastfetch herdr hunk lazygit navi tealdeer television vite-plus

# Stow a specific package (e.g., herdr)
stow -v -R -t ~ herdr

# Unstow a package
stow -v -D -t ~ herdr
```

`fresh`, `superfile` and `omp` are **not** stowed — `install.sh` links them
file-by-file instead. See the comment above `STOW_PACKAGES` for why. Stowing a
package that is also linked by hand does not work: stow refuses to adopt a link it
did not create, so it aborts with `existing target is not owned by stow` and exits
1.

---

## Updating an Existing Machine

```bash
cd ~/dotfiles && git pull --rebase --autostash && ./install.sh
```

Or, from any fish session, `upd dotfiles` — which does the pull, refuses to run
`install.sh` if the autostash left conflict markers, and passes `--config-only`
since it has already updated the packages itself.

Two flags are not optional here. Every config is a stow symlink, so editing one
in a live session writes straight into this repo and the tree is routinely dirty;
`--autostash` is what lets the pull succeed anyway. And `--ff-only` contradicts
`pull.rebase = true` in `~/.gitconfig`, which makes git refuse outright.

### `upd` — one command for all of it

```fish
upd                        # everything
upd apt                    # or any one of:
upd brew mise pi omp dotfiles
```

`opencode` has no target of its own — it is a Homebrew formula, so `upd brew`
covers it.

Order is apt → brew → mise → agents → dotfiles. apt and brew go first because
they are the slow system-package steps and the likeliest to fail, so a failure
there does not mask the rest; dotfiles is last because it re-runs `install.sh`.

Note the mise step runs *before* the pull, so `upd` itself cannot install a tool
that upstream has just added to the config — `mise upgrade` only moves versions
that already exist. That gap is covered by `install.sh`'s own `mise install`,
which is why that step deliberately still runs under `--config-only`.

The **brew** step is `brew update`, then `brew upgrade`, then `brew cleanup`. The
order of the first two is not interchangeable: `upgrade` resolves against the
metadata `update` refreshes, so upgrading against stale metadata skips versions
that were already published when it last ran.

Everything is non-interactive and auto-accepting, because `upd` runs unattended
and a prompt with nobody to answer it just hangs: `apt` gets `-y`, brew runs with
`NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1`, mise with `MISE_YES=1`, and pi/omp
get their approve flags. `sudo` may still ask for a password the first time.

The same brew environment is exported globally in `config.fish`, so an
interactive `brew install` is non-interactive too — a licence or tap prompt in a
terminal you are watching is tolerable; the same prompt inside `upd` is not.
`HOMEBREW_NO_AUTO_UPDATE=1` is what stops brew silently re-running `brew update`
behind every other brew command; `upd brew` does it explicitly instead.

---

## Uninstall / Reset to Default

`uninstall.sh` reverses everything `install.sh` did, in the reverse of the order
`install.sh` set things up: with `--purge`, mise's tools are removed **first**,
while `~/.config/mise/config.toml` is still linked, and only then are the configs
unstowed. (`mise uninstall --all` turns out not to need the config — a dry run
found the same 54 tools with it present and deleted — so this is about not
depending on that staying true, not about fixing a failure.)

```bash
# unstow all configs, restore the default login shell, delete the repo
./uninstall.sh

# also purge installed packages (mise tools, the mise + fish formulas,
# apt packages, global pnpm)
./uninstall.sh --purge

# non-interactive
./uninstall.sh --purge --yes
```

`--purge` removes the 30 mise tools, the `mise` formula, mise's data directories,
the apt base set (`git`, `stow`) and global pnpm
packages.

### The two commands it asks you to run

At the end, `uninstall.sh` prints `cd ~` and — if it just removed the `fish`
binary you were running from — `exec bash`. Both are things **you** must type in
your terminal. A script cannot do either one:

- `cd` is a shell builtin, so a child process has no way to move its parent's
  working directory.
- `exec` replaces the *calling* process. A script's `exec` would replace the
  script, leaving you in a nested shell — `exit` would drop you back to the old
  one. Only `exec` typed in your own shell replaces it for real.

`install.sh` has the same constraint, and for the same reason: if it is run from
inside fish, it prints `Run this to pick up the new config: exec fish` instead of
exec'ing on your behalf. Run it from another shell and it will exec into fish for
you, since there is no fish to nest inside.

**fish is refused, on purpose.** The shell-restore step reads the *current* shell
out of `getent passwd`, so when that is fish the comparison matches and it
changes nothing — `install.sh` ran `chsh` without recording the previous value.
So `/etc/passwd` still points at the brew fish binary when the purge reaches it.
`uninstall.sh` detects that and declines to remove the formula rather than
leaving the account pointing at a path that no longer exists. Finish it by hand:

```bash
chsh -s /bin/bash   # or whatever your distro's default was
brew uninstall fish
```

**Agent data is never deleted.** `~/.pi`, `~/.omp`, `~/.opencode` and `~/.agents` hold session history, credentials and caches that outlive the packages. No flag removes them — `--purge-data` was removed and now exits with an error rather than silently doing nothing.

---

## Pushing to your Remote Git Repository

```bash
cd ~/dotfiles
git remote add origin git@github.com:CMMhero/dotfiles.git
git branch -M main
git push -u origin main
```
