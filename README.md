# dotfiles

Modular dotfiles managed with **GNU Stow**, with `install.sh` / `uninstall.sh` for a zero-to-hero setup or a full reset on fresh Linux / Ubuntu installations.

---

## What's Included

- **Shell (managed)**: Fish (`~/.config/fish`), installed as a **Homebrew formula**, not from apt — brew holds it at a fixed path (`/home/linuxbrew/.linuxbrew/bin/fish`) so upgrading it never breaks `chsh` or herdr's `default_shell`
- **Package managers**: `apt` for the base system, **Homebrew / Linuxbrew** for `fish`, `mise` and `opencode`, `mise` for everything else
- **CLI Tools (via `mise`)**: `atuin`, `bat`, `btop`, `chafa`, `delta`, `eza`, `fastfetch`, `fd`, `fzf`, `gh`, `go`, `herdr`, `hunk`, `jq`, `lazygit`, `neovim`, `node`, `pi`, `pnpm`, `ripgrep`, `rust`, `starship`, `superfile`, `tealdeer`, `uv`, `vite+`, `zoxide`
- **Python**: `uv` (via `mise`)
- **Terminal Workspace & Emulators**:
  - `herdr` (`~/.config/herdr/config.toml`) with custom keybindings, tabs, and Catppuccin theme
  - `wezterm` — **Windows-only**. `wezterm/.wezterm.lua` is kept in the repo for reference (WSL domain, pwsh `default_prog`, Acrylic backdrop) but is **not stowed** and wezterm is **not installed** on Linux.
- **Editor**: `fresh-editor` (`~/.config/fresh`) with the Catppuccin theme package, the `color-highlighter` plugin, a `dotfiles-fresh-language` grammar, vi mode enabled at startup, and a **"Toggle vi mode"** command in the palette (Ctrl+P)
- **Runtimes & Package Managers**: node and pnpm via `mise` (`core:node`, `core:pnpm`). `vite+` is installed as a tool too, but its config sets every runtime and package-manager mode to `system_first`, so it defers to mise instead of managing its own copies.
- **Theme**: Catppuccin Macchiato is the source of truth (defined once in `wezterm/.wezterm.lua`). `bat` uses it directly (`bat/.config/bat/config`), `fzf` gets an equivalent palette via `fish/.config/fish/conf.d/catppuccin.fish`, and `omp` uses its built-in `dark-catppuccin` — that one is **Mocha**-flavoured, since omp ships no Macchiato and `grep -c macchiato` over its dist returns 0.
- **AI Coding Agents**:
  - `omp` (via `mise` as `github:can1357/oh-my-pi`) — **narrowly** stowed: only `~/.omp/agent/config.yml`, `~/.omp/plugins/package.json` and `~/.omp/agent/extensions/opencode-zen-fix.ts`. Everything else in `~/.omp` (sessions, run, logs, cache, `stats.db`, `install-id`, plugin `node_modules`) stays per-machine.
  - `opencode` — installed as a **Homebrew formula**, not a `mise` tool. `mise` tracked it behind the `aqua` backend, which pins an old release with no channel for the current one; brew ships a bottle and tracks upstream itself. Config **not** managed
  - `pi` (`aqua:earendil-works/pi`) — installed via `mise`, config **not** managed
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
   `fish` / `mise` / `opencode` formulas. `mise` is deliberately no longer
   bootstrapped with `curl https://mise.run | sh` — that dropped a second `mise`
   into `~/.local/bin` that could shadow or be shadowed by brew's copy depending on
   PATH order, and `uninstall.sh` then had to delete it by hand. One `mise`, owned
   by brew. `opencode` is a formula rather than a `mise` tool so it tracks upstream
   instead of sitting on a pinned old release; if `mise` still tracks it from an
   older install, `install.sh` unregisters it so it cannot silently shadow brew
   later.
4. Install the missing tools with `mise use -g`: the CLI tools plus `go`, `rust`,
   `node`, `pnpm`, `vite+` and oh-my-pi (`github:can1357/oh-my-pi`), 29 in total.

**Every step installs only what is missing**, and reports what it skipped. apt, brew
and mise all treat a re-install of something present as a no-op, but the resolution
and network round trips behind it are not free — so an already-provisioned machine
skips all three outright. A mise tool counts as present only when it is both
*installed and registered in a config file*: installed-but-unregistered is the state
that makes every shim error with `No version is set for shim`, so those still go
through `mise use -g`.

Steps 3 and 4 run **non-interactive and auto-accepting** — brew with
`NONINTERACTIVE=1` and `HOMEBREW_NO_AUTO_UPDATE=1`, mise with `MISE_YES=1`. Under
`curl … | bash` there is no TTY, so a trust or licence prompt from either is a
hang with nobody to answer it. A `sudo` password prompt is left intact on purpose.
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
stow -v -R -t ~ fish git starship atuin bat btop fastfetch herdr hunk lazygit vite-plus

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

`uninstall.sh` reverses everything `install.sh` did.

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
