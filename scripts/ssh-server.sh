#!/usr/bin/env bash
# ==============================================================================
# ssh-server.sh - provision sshd inside WSL so Herdr (and you) can reach it.
#
# Lives in the WSL repo rather than being reached into from install.ps1, for
# three reasons:
#
#   * WSL provisions itself. Windows reaching in with `wsl.exe -u root sh -lc`
#     for every step means the knowledge is split across two machines and two
#     languages, and the half that runs inside the distro is the half that has to
#     work on a fresh distro.
#   * Order is knowable here. ssh.socket only starts once systemd is running,
#     and systemd only runs once wsl.conf says so AND the distro has restarted.
#     A script that lives here can check all of that in one place.
#   * It is runnable on its own: `sudo bash ~/dotfiles/scripts/ssh-server.sh`
#     after something has gone wrong, without re-running a Windows installer.
#
# Usage:
#   sudo bash scripts/ssh-server.sh                        # defaults
#   sudo bash scripts/ssh-server.sh --port 2222 --user $USER \
#        --pubkey "$(cat ~/.ssh/id_ed25519.pub)"
#
# Idempotent throughout: safe to run repeatedly, and safe to run on a machine
# that already works.
#
# Ports: 2222, not 22. Windows reaches WSL through a localhost relay on the
# Windows side, and 22 inside WSL collides with other things far too easily to
# be worth the fight. The Windows ssh config points `Host linux` at
# 127.0.0.1:2222 to match.
# ==============================================================================
set -euo pipefail

PORT=2222
TARGET_USER="${SUDO_USER:-${USER:-root}}"
PUBKEY=""
RUN_AS_ROOT=0

log_step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
log_info() { printf '   \033[0;36m->\033[0m %s\n' "$*"; }
log_ok()   { printf '   \033[1;32m[ok]\033[0m   %s\n' "$*"; }
log_warn() { printf '   \033[1;33m[warn]\033[0m %s\n' "$*"; }
log_err()  { printf '   \033[1;31m[err]\033[0m  %s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)   PORT="$2"; shift 2 ;;
    --user)   TARGET_USER="$2"; shift 2 ;;
    --pubkey) PUBKEY="$2"; shift 2 ;;
    --check)  RUN_AS_ROOT=0; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) log_err "unknown option: $1"; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ] && [ "$RUN_AS_ROOT" -eq 0 ]; then
  log_err "must run as root (writes to /etc and /run)"
  log_info "  sudo bash $0 $*"
  exit 1
fi

# ------------------------------------------------------------------------------
# 1. openssh-server
# ------------------------------------------------------------------------------
if [ ! -x /usr/sbin/sshd ]; then
  log_step "Installing openssh-server"
  # `apt-get update` FIRST. On a fresh distro the index is stale or absent and
  # the install fails with "Unable to locate package" -- silently, if the output
  # is being discarded, which is how a machine ends up with no sshd and a step
  # that reported success.
  log_info "apt-get update (first run can take a minute)"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || log_warn "apt-get update failed; trying the install anyway"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null 2>&1 || true
fi
if [ -x /usr/sbin/sshd ]; then
  log_ok "openssh-server present"
else
  log_err "openssh-server is not installed and could not be installed"
  exit 1
fi

# ------------------------------------------------------------------------------
# 2. systemd has to be running at all
# ------------------------------------------------------------------------------
# Everything below is `systemctl`. Without systemd there is no socket unit, no
# tmpfiles run, and every command fails in a way that reads like a missing
# package rather than a missing init.
if ! command -v systemctl >/dev/null 2>&1 || [ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]; then
  log_err "systemd is not PID 1 in this distro"
  log_info "  enable it in /etc/wsl.conf:"
  log_info "      [boot]"
  log_info "      systemd=true"
  log_info "  then from Windows:  wsl --shutdown   (wsl.conf is only read at boot)"
  exit 1
fi
log_ok "systemd is running"

# ------------------------------------------------------------------------------
# 3. Port
# ------------------------------------------------------------------------------
# Written into sshd_config.d, which sshd reads. NOTE: this does NOT affect
# ssh.socket -- see section 4, which is the part that was wrong for a long time.
CONF_DIR=/etc/ssh/sshd_config.d
PORT_CONF="$CONF_DIR/10-port.conf"
mkdir -p "$CONF_DIR"
if [ "$(cat "$PORT_CONF" 2>/dev/null)" = "Port $PORT" ]; then
  log_ok "Port $PORT already configured"
else
  printf 'Port %s\n' "$PORT" > "$PORT_CONF"
  chmod 644 "$PORT_CONF"
  log_ok "Port $PORT configured ($PORT_CONF)"
fi

# ------------------------------------------------------------------------------
# 4. The socket -- with an explicit drop-in
# ------------------------------------------------------------------------------
# This is the part that was quietly wrong, and it is worth stating plainly:
#
# systemd's ssh GENERATOR builds ssh.socket's ListenStream from
# /etc/ssh/ssh_config.d/ -- the CLIENT config directory. `Port` in
# /etc/ssh/sshd_config.d/ is read by sshd and NOT by the generator. So the
# generated socket comes up on 22 no matter what the sshd config says, and
# restarting the socket reproduces the wrong port every time.
#
# The drop-in states the addresses outright instead.
#
# Both, and the leading empty ListenStream, each matter:
#   * `ListenStream=` with no value RESETS the list. Without it the generated 22
#     stays bound alongside 2222.
#   * A single `ListenStream=2222` binds IPv6 ONLY -- measured, and it left IPv4
#     dead, which matters because Windows connects over IPv4.
mkdir -p /etc/systemd/system/ssh.socket.d
SOCKET_DROPIN=/etc/systemd/system/ssh.socket.d/override.conf
SOCKET_WANT="[Socket]
ListenStream=
ListenStream=0.0.0.0:$PORT
ListenStream=[::]:$PORT"

if [ "$(cat "$SOCKET_DROPIN" 2>/dev/null)" = "$SOCKET_WANT" ]; then
  log_ok "ssh.socket drop-in already correct"
else
  printf '%s\n' "$SOCKET_WANT" > "$SOCKET_DROPIN"
  chmod 644 "$SOCKET_DROPIN"
  log_ok "ssh.socket drop-in written (binds 0.0.0.0:$PORT and [::]:$PORT)"
fi

# Run a systemctl command and REPORT it if it fails.
#
# The previous version appended >/dev/null 2>&1 to all of these, which is how a
# bare "Job failed. See journalctl -xe for details." reached the terminal with no
# indication of which command produced it. systemctl's own message is the useful
# part; it is kept, and pointed at the right unit's journal.
systemctl_try() {
    _what="$1"; shift
    _out="$("$@" 2>&1)" && return 0
    log_warn "$_what failed: $_out"
    case "$_what" in
        *socket*) _unit="ssh.socket" ;;
        *)        _unit="ssh.service" ;;
    esac
    log_info "  journalctl -xe -u $_unit"
    return 1
}

# Stop the SERVICE before restarting the socket.
#
# With socket activation the service sits idle until a connection arrives -- but
# once one has, sshd is running and holding the port ITSELF. Restarting the
# socket underneath it cannot bind, and systemd says "Job failed". On a machine
# that has never been connected to this never happens, which is why it showed up
# on a fresh laptop and not on the machine this was developed on.
#
# The service is not started again afterwards: with the socket holding the port,
# the next connection starts it. That is the whole point of the arrangement.
if systemctl is-active --quiet ssh.service; then
    log_info "stopping ssh.service so the socket can take the port back"
    systemctl_try "stop ssh.service" systemctl stop ssh.service || true
fi

log_info "daemon-reload, enable, restart"
systemctl_try "daemon-reload"  systemctl daemon-reload  || true
systemctl_try "enable ssh.socket" systemctl enable ssh.socket || log_warn "could not enable ssh.socket (it may be enabled already)"
systemctl_try "restart ssh.socket" systemctl restart ssh.socket || {
    log_warn "ssh.socket did not restart; the unit may still hold the old port"
    # One more attempt with the socket stopped first, which is the other common
    # cause of a failed bind.
    systemctl_try "stop ssh.socket"  systemctl stop ssh.socket  || true
    systemctl_try "start ssh.socket" systemctl start ssh.socket || true
}

LISTEN="$(systemctl show ssh.socket -p Listen --value 2>/dev/null | tr '\n' ' ' | tr -s ' ')"
if printf '%s' "$LISTEN" | grep -q ":$PORT"; then
  log_ok "ssh.socket listening on $LISTEN"
else
  log_err "ssh.socket is NOT on $PORT (it is on:$LISTEN)"
  log_err "  something else is overriding the drop-in; check"
  log_err "  /etc/systemd/system/ssh.socket.d/ and any *.socket in /run/systemd/generator*/"
  exit 1
fi

# ------------------------------------------------------------------------------
# 5. Privilege separation directory
# ------------------------------------------------------------------------------
# /run is tmpfs, so /run/sshd does not survive a restart, and sshd refuses to
# start without it:
#     Missing privilege separation directory: /run/sshd
#
# ssh.service declares RuntimeDirectory=sshd, but that only fires once the
# service starts, which with socket activation is after the first connection.
# Anything that validates sshd before then -- `sshd -t` in a setup script, a
# health check -- fails. So: create it now, AND add a tmpfiles rule so the
# guarantee does not depend on when sshd happens to be started.
mkdir -p /run/sshd && chmod 0755 /run/sshd
log_ok "/run/sshd present"

TMPFILES=/etc/tmpfiles.d/ssh-privsep.conf
if [ "$(cat "$TMPFILES" 2>/dev/null)" != "d /run/sshd 0755 root root -" ]; then
  printf 'd /run/sshd 0755 root root -\n' > "$TMPFILES"
  chmod 644 "$TMPFILES"
  systemd-tmpfiles --create >/dev/null 2>&1 || true
  log_ok "tmpfiles rule installed (survives a restart)"
else
  log_ok "tmpfiles rule already present"
fi

# ------------------------------------------------------------------------------
# 6. Config check
# ------------------------------------------------------------------------------
# Run as root: an unprivileged `sshd -t` fails with "no hostkeys available",
# which looks like a broken config rather than a missing privilege.
if OUT="$(/usr/sbin/sshd -t 2>&1)"; then
  log_ok "sshd -t: config accepted"
else
  log_err "sshd -t rejected the config: $OUT"
  exit 1
fi

# ------------------------------------------------------------------------------
# 7. authorized_keys for the target user
# ------------------------------------------------------------------------------
if [ -n "$PUBKEY" ]; then
  HOME_DIR="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  AK_DIR="$HOME_DIR/.ssh"
  AK="$AK_DIR/authorized_keys"
  install -d -m 700 -o "$TARGET_USER" -g "$(id -gn "$TARGET_USER")" "$AK_DIR"
  touch "$AK"
  if grep -qF "$PUBKEY" "$AK" 2>/dev/null; then
    log_ok "authorized_keys already contains this key"
  else
    printf '%s\n' "$PUBKEY" >> "$AK"
    chown "$TARGET_USER:$(id -gn "$TARGET_USER")" "$AK"
    chmod 600 "$AK"
    log_ok "authorized_keys written for $TARGET_USER"
  fi
else
  log_info "no --pubkey given; leaving authorized_keys alone"
fi

# ------------------------------------------------------------------------------
# 8. Verify by connecting, not by asking systemd
# ------------------------------------------------------------------------------
# `systemctl status ssh` reporting "inactive (dead)" is CORRECT here, not a
# fault: ssh.socket holds the port and spawns ssh.service on the first
# connection, so the service is *supposed* to sit idle. Checking
# `is-active ssh` reports a healthy setup as broken. The listening socket is the
# signal, and the check above already used it.
log_step "Done"
log_ok "sshd is listening on $PORT via ssh.socket (systemd is PID 1, so this survives 'wsl --shutdown')"
log_info "from Windows:  ssh -p $PORT <user>@127.0.0.1"
log_info "from WSL:      ssh -p $PORT <user>@127.0.0.1"
log_info "re-run any time:  sudo bash $0"