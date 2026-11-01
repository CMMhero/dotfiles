#!/usr/bin/env bash
# ==============================================================================
# scripts/sync-atuin.sh - the parts of Atuin that live outside its config.toml.
#
# Usage:
#   ./sync-atuin.sh              # sync, re-point agents, import threads
#   ./sync-atuin.sh -f           # atuin sync -f: re-download everything
#   ./sync-atuin.sh --no-import  # skip `atuin threads import`
#   ./sync-atuin.sh -n           # dry run, print only
#
# The WSL counterpart of dotfiles-win/sync-atuin.ps1. Run by install.sh and by
# `upd atuin`; these are the reasons it exists:
#
# 1. The sync itself is not a file, so chezmoi/stow cannot deploy it.
# 2. `atuin hook install` and `atuin mcp install` write the ABSOLUTE path of the
#    running atuin binary into each agent's OWN config. Those paths are
#    version-pinned, so `mise upgrade atuin` (which installs a new version
#    directory) leaves every hook and every MCP entry pointing at a binary that
#    no longer exists. A hook that cannot spawn records nothing, so the failure
#    is silent until you notice history has no agent entries.
# 3. Thread capture only starts when it is switched on; `threads import` is what
#    brings in every session the agents already had.
#
# Every step is idempotent, and one failure does not stop the rest.
# ==============================================================================

set -uo pipefail

FORCE=0
NO_IMPORT=0
DRY=0

for arg in "$@"; do
    case "$arg" in
        -f|--force)    FORCE=1 ;;
        --no-import)   NO_IMPORT=1 ;;
        -n|--dry-run)  DRY=1 ;;
        -h|--help)     sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

RULE='==============================================================='
FAILURES=()

step() { printf '\n%s\n  %s\n%s\n' "$RULE" "$1" "$RULE"; }
info() { printf '   -> %s\n' "$1"; }
ok()   { printf '   [ok] %s\n' "$1"; }
warn() { printf '   [!!] %s\n' "$1" >&2; }
skip() { printf '   [--] %s\n' "$1"; }

if ! command -v atuin >/dev/null 2>&1; then
    warn 'atuin is not on PATH -- skipping.'
    warn 'It comes from mise: `mise install` then restart the shell.'
    exit 0
fi

step "Atuin sync ($(atuin --version 2>&1 | head -1))"

# ------------------------------------------------------------------------------
# 1. Sync
#
# Plain `atuin sync` moves only what is missing on either side. -f re-writes
# everything, so it is opt-in: on a healthy store it is pure waste, and the one
# time it is right (a store that disagrees with the server) is worth a flag.
# ------------------------------------------------------------------------------
if [ "$DRY" = 1 ]; then
    # `${FORCE:+ -f}` would be wrong here: FORCE is the string "0" when the flag
    # is absent, and "0" is non-empty, so the ternary always fired.
    if [ "$FORCE" = 1 ]; then info 'dry run: would run atuin sync -f'; else info 'dry run: would run atuin sync'; fi
    skip 'not run'
elif [ "$FORCE" = 1 ]; then
    info 'atuin sync -f (full re-download)'
    sync_out=$(atuin sync -f 2>&1); sync_rc=$?
    [ "$sync_rc" -eq 0 ] || { warn "sync failed (exit $sync_rc)"; FAILURES+=('atuin sync'); }
    [ "$sync_rc" -ne 0 ] && printf '%s\n' "$sync_out"
    [ "$sync_rc" -eq 0 ] && { summary=$(printf '%s\n' "$sync_out" | grep -o 'Sync complete.*' | tail -1); ok "${summary:-synced}"; }
else
    info 'atuin sync'
    sync_out=$(atuin sync 2>&1); sync_rc=$?
    if [ "$sync_rc" -eq 0 ]; then
        summary=$(printf '%s\n' "$sync_out" | grep -o 'Sync complete.*' | tail -1)
        ok "${summary:-synced}"
    elif printf '%s' "$sync_out" | grep -qi 'not logged in\|not registered\|unregistered\|no account'; then
        # Normal on a fresh machine: history works locally without an account.
        skip 'not signed in -- history is local only (run `atuin register` to sync)'
    else
        warn "sync failed (exit $sync_rc)"
        printf '%s\n' "$sync_out"
        FAILURES+=('atuin sync')
    fi
fi

# ------------------------------------------------------------------------------
# 2. Agent hooks
#
# Re-running is safe and is the repair path for a stale version-pinned path.
# ------------------------------------------------------------------------------
step 'Agent hooks'

# agent -> the command whose presence means "installed here"
agent_probes=(
    'claude-code:claude'
    'codex:codex'
    'copilot:copilot'
    'opencode:opencode'
    'pi:pi'
    'omp:omp'
)

for entry in "${agent_probes[@]}"; do
    agent=${entry%%:*}
    probe=${entry##*:}
    if ! command -v "$probe" >/dev/null 2>&1; then
        skip "$agent -- not installed"
        continue
    fi
    if [ "$DRY" = 1 ]; then
        info "atuin hook install $agent"
        skip 'dry run: would install'
        continue
    fi
    info "atuin hook install $agent"
    hook_out=$(atuin hook install "$agent" 2>&1); hook_rc=$?
    if [ "$hook_rc" -ne 0 ]; then
        warn "$agent -- hook install failed (exit $hook_rc)"
        FAILURES+=("hook $agent")
    elif printf '%s' "$hook_out" | grep -q 'already installed'; then
        skip "$agent -- hooks current"
    else
        ok "$agent -- hooks installed"
    fi
done

# Cline's hooks are extensionless scripts Cline runs through a shebang, and
# Atuin has no Cline harness at all, so Cline gets the MCP entry below only.
skip 'cline -- Atuin has no Cline hook; it gets the MCP server below'

# ------------------------------------------------------------------------------
# 3. Agent MCP servers
# ------------------------------------------------------------------------------
step 'Agent MCP servers'

for entry in "${agent_probes[@]}"; do
    agent=${entry%%:*}
    probe=${entry##*:}
    if ! command -v "$probe" >/dev/null 2>&1; then
        skip "$agent -- not installed"
        continue
    fi
    if [ "$DRY" = 1 ]; then
        info "atuin mcp install $agent"
        skip 'dry run: would register'
        continue
    fi
    info "atuin mcp install $agent"
    if atuin mcp install "$agent" >/dev/null 2>&1; then
        ok "$agent -- MCP server registered"
    else
        warn "$agent -- mcp install failed (exit $?)"
        FAILURES+=("mcp $agent")
    fi
done

# Cline is not in Atuin's harness list, but its own CLI has a non-interactive
# installer that writes Cline's settings file:
#   ~/.cline/data/settings/cline_mcp_settings.json
# `<name> -- <command> <args>` is Cline's stdio form; --yes avoids the TUI
# wizard, which a script cannot drive.
if command -v cline >/dev/null 2>&1; then
    atuin_bin=$(command -v atuin)
    if [ "$DRY" = 1 ]; then
        info "cline mcp install atuin --yes -- $atuin_bin mcp"
        skip 'dry run: would register'
    else
        info 'cline mcp install atuin --yes'
        if cline mcp install atuin --yes -- "$atuin_bin" mcp >/dev/null 2>&1; then
            ok 'cline -- MCP server registered'
        else
            warn 'cline -- mcp install failed'
            FAILURES+=('mcp cline')
        fi
    fi
else
    skip 'cline -- not installed'
fi

# ------------------------------------------------------------------------------
# 4. Thread import
# ------------------------------------------------------------------------------
step 'Thread import'

if [ "$NO_IMPORT" = 1 ]; then
    skip 'skipped (--no-import)'
elif [ "$DRY" = 1 ]; then
    info 'atuin threads import'
    skip 'dry run: would import'
else
    capture=$(atuin config get threads.capture -r 2>&1)
    if [ "$capture" != "true" ]; then
        skip 'thread capture is off -- run `atuin config enable threads`'
    else
        info 'atuin threads import'
        import_out=$(atuin threads import 2>&1); import_rc=$?
        if [ "$import_rc" -eq 0 ]; then
            summary=$(printf '%s\n' "$import_out" | grep '^done:' | tail -1)
            ok "${summary:-threads imported}"
        else
            warn "thread import failed (exit $import_rc)"
            FAILURES+=('threads import')
        fi
    fi
fi

# ------------------------------------------------------------------------------
# 5. Doctor
# ------------------------------------------------------------------------------
step 'Doctor'

if [ "$DRY" = 1 ]; then
    info 'dry run: would run atuin doctor'
else
    doctor=$(atuin doctor 2>&1)
    if [ $? -eq 0 ]; then
        ok 'doctor clean'
        auth=$(printf '%s\n' "$doctor" | sed -n 's/.*"auth_state": *"\([^"]*\)".*/\1/p' | head -1)
        info "auth: ${auth:-unknown}"
    else
        warn 'doctor failed'
        FAILURES+=('atuin doctor')
    fi
fi

# ------------------------------------------------------------------------------
printf '\n'
if [ ${#FAILURES[@]} -gt 0 ]; then
    warn "${#FAILURES[@]} step(s) failed: ${FAILURES[*]}"
    printf '   Re-run this script after fixing, or check `atuin doctor`.\n'
    exit 1
fi
if [ "$DRY" = 1 ]; then
    info 'dry run: nothing was changed.'
else
    ok 'Atuin is in sync with this machine.'
fi
exit 0
