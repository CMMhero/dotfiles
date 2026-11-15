#!/usr/bin/env bash
# ==============================================================================
# scripts/usage-timer.sh - collect this box's agent usage once a day, in the
# background. The Linux counterpart of dotfiles-win/sync-usage.ps1.
#
# Usage:
#   scripts/usage-timer.sh install [HH:MM]   # register the daily timer (default 12:00)
#   scripts/usage-timer.sh uninstall
#   scripts/usage-timer.sh status
#   scripts/usage-timer.sh run               # one collection pass, right now
#
# A systemd USER timer: no root, no cron, no window. Persistent=true means a box
# that was off at the trigger time runs the missed pass at next boot, so the
# snapshot still lands once a day. It runs `usage collect --local-only`, because
# each Linux box scans its own transcripts; the Windows PC is the hub that pulls
# remotes over ssh, and a second hub from here would only fight it for the share.
#
# Without systemd (a container, or WSL with systemd off) it falls back to a
# crontab line. Both paths are idempotent: install twice and there is still one
# timer.
# ==============================================================================
set -euo pipefail

UNIT=usage-collect
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CRON_TAG="# usage-collect (managed by dotfiles)"

usage_bin() {
  if command -v usage >/dev/null 2>&1; then command -v usage
  elif [ -x "$HOME/.local/bin/usage" ]; then echo "$HOME/.local/bin/usage"
  else echo "usage-timer: no \`usage\` on PATH; stow the usage package first" >&2; return 1; fi
}

have_systemd_user() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

valid_time() { [[ "$1" =~ ^([01]?[0-9]|2[0-3]):[0-5][0-9]$ ]]; }

install_timer() {
  local at="${1:-12:00}" bin hh mm
  valid_time "$at" || { echo "usage-timer: time must be HH:MM, got '$at'" >&2; exit 2; }
  bin="$(usage_bin)"
  hh="${at%%:*}"; mm="${at##*:}"

  if have_systemd_user; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/$UNIT.service" <<UNITEOF
[Unit]
Description=Collect agent usage snapshots for this host

[Service]
Type=oneshot
ExecStart=$bin collect --local-only
Nice=10
TimeoutStartSec=1h
UNITEOF
    cat > "$UNIT_DIR/$UNIT.timer" <<UNITEOF
[Unit]
Description=Collect agent usage once a day

[Timer]
OnCalendar=*-*-* $(printf '%02d:%02d' "$((10#$hh))" "$((10#$mm))"):00
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
UNITEOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT.timer" >/dev/null
    echo "usage-timer: daily at $at via systemd user timer ($UNIT.timer)"
    # A user timer only fires while the user manager runs. linger keeps it up
    # after logout; without it the timer waits for the next login, which is why
    # Persistent=true matters.
    if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
      echo "  tip: sudo loginctl enable-linger $USER   (run while logged out too)"
    fi
  elif command -v crontab >/dev/null 2>&1; then
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true
      echo "$((10#$mm)) $((10#$hh)) * * * $bin collect --local-only >/dev/null 2>&1 $CRON_TAG"
    } | crontab -
    echo "usage-timer: daily at $at via crontab (no systemd user session here)"
  else
    echo "usage-timer: neither systemd --user nor crontab is available" >&2
    exit 1
  fi
}

uninstall_timer() {
  if have_systemd_user && [ -f "$UNIT_DIR/$UNIT.timer" ]; then
    systemctl --user disable --now "$UNIT.timer" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT.timer" "$UNIT_DIR/$UNIT.service"
    systemctl --user daemon-reload
    echo "usage-timer: removed systemd timer"
  fi
  if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$CRON_TAG"; then
    crontab -l | grep -vF "$CRON_TAG" | crontab -
    echo "usage-timer: removed crontab entry"
  fi
}

status_timer() {
  if have_systemd_user && [ -f "$UNIT_DIR/$UNIT.timer" ]; then
    systemctl --user list-timers "$UNIT.timer" --no-pager
  elif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -F "$CRON_TAG"; then
    :
  else
    echo "usage-timer: not installed"
  fi
}

case "${1:-status}" in
  install) install_timer "${2:-12:00}" ;;
  uninstall) uninstall_timer ;;
  status) status_timer ;;
  run) exec "$(usage_bin)" collect --local-only ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
