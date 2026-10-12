#!/usr/bin/env bash
# ==============================================================================
# wsl/setup-ssh.sh - make a WSL distro reachable over ssh on port 2222, started
# automatically, and reachable as herdr's `linux` machine.
#
#   ./wsl/setup-ssh.sh
#   ./wsl/setup-ssh.sh --pubkey "ssh-ed25519 AAAA... windows-pc"
#   ./wsl/setup-ssh.sh --pubkey-only      # also refuse password logins
#   ./wsl/setup-ssh.sh --no-ssh-config    # skip the 'Host linux' block
#
# Idempotent: every step checks before it writes, so re-running on an already
# provisioned distro changes nothing. Everything that lives on the *Windows*
# side (.wslconfig, `herdr machine add`) cannot be done from here -- those steps
# are printed at the end.
#
# Why 2222 and not 22: Windows' own OpenSSH client/server owns 22 on the
# loopback side of the WSL/Windows boundary, and sshd binding 0.0.0.0:2222 with
# `localhostforwarding=true` in .wslconfig sidesteps the clash entirely.
#
# Why socket activation rather than `systemctl enable ssh`: WSL does not have a
# reliable "on login" trigger, and a socket unit is started by systemd at boot
# even when nothing is listening for connections yet. ssh.socket is therefore
# enabled and ssh.service stays disabled -- it is pulled in as a trigger of the
# socket on the first inbound connection. Keeps running is ssh.service's own
# `Restart=on-failure`, which is in the distro unit; nothing to add.
#
# The `linux` ssh config entry is the piece that makes herdr work: herdr's
# Windows client runs `ssh linux`, and 127.0.0.1 inside the distro is the distro
# itself, so the same entry works from Windows and from inside WSL.
# ==============================================================================

set -euo pipefail

SSH_PORT=2222
SSH_USER="${USER:-$(id -un)}"
PUBKEY=""
PUBKEY_ONLY=0
WRITE_SSH_CONFIG=1

while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey) PUBKEY="${2:?--pubkey needs a value}"; shift 2 ;;
    --pubkey=*) PUBKEY="${1#*=}"; shift ;;
    --pubkey-only) PUBKEY_ONLY=1; shift ;;
    --no-ssh-config) WRITE_SSH_CONFIG=0; shift ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Run as root when invoked as root; otherwise borrow sudo.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || { echo "sudo is required" >&2; exit 1; }
  SUDO="sudo"
fi

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    %s\n' "$*"; }

# ------------------------------------------------------------------------------
# 0. Refuse to run outside WSL
# ------------------------------------------------------------------------------
step "Checking this is WSL"
if ! grep -qi microsoft /proc/sys/kernel/osrelease; then
  echo "    /proc/sys/kernel/osrelease has no 'microsoft' -- this is not WSL." >&2
  echo "    On a plain Linux box use the distro's own openssh-server setup." >&2
  exit 1
fi
ok "WSL detected"

# ------------------------------------------------------------------------------
# 1. systemd must be on, or nothing below can work
# ------------------------------------------------------------------------------
step "systemd enabled in /etc/wsl.conf"
mkdir -p /etc
if [ -f /etc/wsl.conf ] && grep -Eq '^\s*systemd\s*=\s*true' /etc/wsl.conf; then
  ok "already set"
else
  # Preserve every section except [boot], which is rewritten from scratch.
  # Dropping a [user] default=<name> would change which account WSL launches
  # as, which is exactly the kind of silent breakage a provisioning script
  # must not cause.
  $SUDO tee /tmp/wsl.conf.new >/dev/null <<'EOF'
# [boot] rewritten by dotfiles/wsl/setup-ssh.sh
[boot]
systemd=true
EOF
  if [ -f /etc/wsl.conf ]; then
    $SUDO awk '
      /^\[/          { skipping = ($0 ~ /^[[:space:]]*\[boot\][[:space:]]*$/) }
      skipping       { next }
      /^[[:space:]]*($|#)/ || NF == 0 { next }
      { print }
    ' /etc/wsl.conf >/tmp/wsl.conf.rest
    cat /tmp/wsl.conf.rest >>/tmp/wsl.conf.new
    $SUDO cp /etc/wsl.conf /etc/wsl.conf.bak-setup-ssh
    $SUDO mv /tmp/wsl.conf.new /etc/wsl.conf
    rm -f /tmp/wsl.conf.rest
    ok "rewrote [boot] in /etc/wsl.conf (other sections kept, backup at /etc/wsl.conf.bak-setup-ssh)"
  else
    $SUDO mv /tmp/wsl.conf.new /etc/wsl.conf
    ok "created /etc/wsl.conf"
  fi
  echo "    NOTE: systemd only takes effect after 'wsl --shutdown' from Windows."
fi

# ------------------------------------------------------------------------------
# 2. openssh-server
# ------------------------------------------------------------------------------
step "openssh-server"
if dpkg-query -W -f='${Status}' openssh-server 2>/dev/null | grep -q "install ok installed"; then
  ok "already installed"
else
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq openssh-server
  ok "installed"
fi

# Host keys: sshd-keygen.service does this at first boot, but only under
# ConditionFirstBoot -- a distro imported from a tarball can already have a
# "booted" marker and no keys at all.
step "Host keys"
MISSING=0
for t in rsa ecdsa ed25519; do
  [ -f "/etc/ssh/ssh_host_${t}_key" ] || MISSING=1
done
if [ "$MISSING" -eq 1 ]; then
  $SUDO ssh-keygen -A >/dev/null
  ok "generated missing host keys"
else
  ok "all present"
fi

# ------------------------------------------------------------------------------
# 3. Port 2222
# ------------------------------------------------------------------------------
# One file is normally enough: /etc/ssh/sshd_config.d/10-port.conf. Ubuntu's
# sshd-socket-generator reads that Port and emits the matching ListenStream into
# /run/systemd/generator/ssh.socket.d/addresses.conf on every daemon-reload,
# which is how the socket ends up on 2222 rather than the 22 baked into
# /usr/lib/systemd/system/ssh.socket.
#
# A hand-written /etc/systemd/system/ssh.socket.d/10-port.conf is the fallback,
# written only if the generated one did not take. It takes precedence over the
# generator, so if one exists it wins regardless of sshd_config -- which is why
# this script checks the effective Listen instead of assuming.
step "Port $SSH_PORT"
$SUDO mkdir -p /etc/ssh/sshd_config.d
if [ -f /etc/ssh/sshd_config.d/10-port.conf ] \
   && [ "$(cat /etc/ssh/sshd_config.d/10-port.conf)" = "Port $SSH_PORT" ]; then
  ok "sshd_config.d/10-port.conf already correct"
else
  printf 'Port %s\n' "$SSH_PORT" | $SUDO tee /etc/ssh/sshd_config.d/10-port.conf >/dev/null
  ok "wrote /etc/ssh/sshd_config.d/10-port.conf"
fi

# Refuse to go further on a config sshd will reject, rather than leaving the
# distro with no reachable sshd at all.
$SUDO sshd -t || { echo "    sshd rejected the config -- not restarting anything." >&2; exit 1; }
$SUDO systemctl daemon-reload
$SUDO systemctl restart ssh.socket
sleep 1
if systemctl show ssh.socket -p Listen | grep -q ":$SSH_PORT"; then
  ok "ssh.socket listens on $SSH_PORT (from the generated addresses.conf)"
else
  $SUDO mkdir -p /etc/systemd/system/ssh.socket.d
  printf '[Socket]\nListenStream=\nListenStream=%s\n' "$SSH_PORT" \
    | $SUDO tee /etc/systemd/system/ssh.socket.d/10-port.conf >/dev/null
  $SUDO systemctl daemon-reload
  $SUDO systemctl restart ssh.socket
  ok "generator did not pick up the port; wrote the ssh.socket drop-in"
fi

# ------------------------------------------------------------------------------
# 4. Autostart and keep running
# ------------------------------------------------------------------------------
# ssh.socket enabled + ssh.service disabled = socket activation. ssh.service is
# a Requires of nothing; the socket pulls it in on first connection. Its
# Restart=on-failure is what keeps it up.
step "Socket activation"
$SUDO systemctl enable ssh.socket >/dev/null 2>&1 || true
if systemctl is-enabled --quiet ssh.service; then
  $SUDO systemctl disable ssh.service >/dev/null 2>&1 || true
  ok "ssh.service disabled (socket-activated)"
fi
$SUDO systemctl restart ssh.socket
$SUDO systemctl start sshd-keygen.service 2>/dev/null || true
ok "ssh.socket enabled and (re)started"

# ------------------------------------------------------------------------------
# 5. Who may log in
# ------------------------------------------------------------------------------
# Publickey auth is on by default and is what herdr and `ssh linux` use, so
# nothing has to be written for this to work. The block below additionally
# turns password auth off -- opt-in with --pubkey-only, because that lockout is
# a real risk if the only authorized key is ever wrong, and it must not happen
# to someone who did not ask for it.
step "Authentication"
if [ "$PUBKEY_ONLY" -eq 1 ]; then
  $SUDO mkdir -p /etc/ssh/sshd_config.d
  cat >/tmp/auth.conf <<'EOF'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  if [ -f /etc/ssh/sshd_config.d/20-auth.conf ] \
     && diff -q /etc/ssh/sshd_config.d/20-auth.conf /tmp/auth.conf >/dev/null 2>&1; then
    ok "20-auth.conf already correct (pubkey only)"
  else
    $SUDO tee /etc/ssh/sshd_config.d/20-auth.conf </tmp/auth.conf >/dev/null
    ok "wrote /etc/ssh/sshd_config.d/20-auth.conf (pubkey only)"
    echo "    Confirm you can still log in before closing this session:"
    echo "      ssh -i ~/.ssh/id_ed25519 -p $SSH_PORT $SSH_USER@127.0.0.1 true"
  fi
  rm -f /tmp/auth.conf
  $SUDO sshd -t || { echo "    sshd rejected the config -- not restarting anything." >&2; exit 1; }
  $SUDO systemctl restart ssh.socket
else
  ok "pubkey auth is on by default; password auth left as-is (--pubkey-only to disable)"
fi

# ------------------------------------------------------------------------------
# 6. Client key in authorized_keys
# ------------------------------------------------------------------------------
step "authorized_keys"
# $USER is the Linux account, which is usually not the Windows one -- `cmmhero`
# vs `CMM` here -- so glob for the Windows profile instead of guessing.
if [ -z "$PUBKEY" ]; then
  for candidate in /mnt/c/Users/*/.ssh/id_ed25519.pub; do
    [ -f "$candidate" ] || continue
    case "$(basename "$(dirname "$(dirname "$candidate")")")" in
      Public|"All Users"|Default*|WsiAccount) continue ;;
    esac
    PUBKEY="$(cat "$candidate")"
    ok "picked up the Windows key from $candidate"
    break
  done
fi

mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"

if [ -n "$PUBKEY" ]; then
  # Windows .pub files are CRLF-terminated, and a key pasted from one carries
  # the stray \r. It would not match an existing LF line, so the script would
  # append the same key on every run. Compare on the key type + blob only, not
  # the trailing comment -- a re-tagged key is still the same key.
  if ! printf '%s\n' "$PUBKEY" | tr -d '\r' >/tmp/pubkey.check \
     || ! ssh-keygen -l -f /tmp/pubkey.check >/dev/null 2>&1; then
    rm -f /tmp/pubkey.check
    echo "    --pubkey is not a valid public key line; not adding it." >&2
    exit 1
  fi
  rm -f /tmp/pubkey.check
  KEY_FIELDS="$(printf '%s' "$PUBKEY" | tr -d '\r\n' | awk 'NF >= 2 {print $1" "$2}')"
  if tr -d '\r' <"$HOME/.ssh/authorized_keys" | awk 'NF >= 2 {print $1" "$2}' | grep -qxF "$KEY_FIELDS"; then
    ok "key already authorized"
  else
    printf '%s\n' "$(printf '%s' "$PUBKEY" | tr -d '\r')" >>"$HOME/.ssh/authorized_keys"
    ok "added key to authorized_keys"
  fi
else
  echo "    No --pubkey given and no Windows key found."
  echo "    Add one manually:  echo '<pubkey>' >> $HOME/.ssh/authorized_keys"
fi

# The ssh client key the `linux` entry will use. Generate rather than fail:
# without it `ssh linux` has no identity at all.
if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -C "$SSH_USER@wsl" -f "$HOME/.ssh/id_ed25519" >/dev/null
  ok "generated $HOME/.ssh/id_ed25519 for outbound ssh from inside the distro"
else
  ok "client key present"
fi
chmod 600 "$HOME/.ssh/id_ed25519" 2>/dev/null || true
chmod 644 "$HOME/.ssh/id_ed25519.pub" 2>/dev/null || true

# ------------------------------------------------------------------------------
# 7. The `linux` ssh config entry
# ------------------------------------------------------------------------------
# ~/.ssh/config is local-only and must never enter the repo (it carries host IPs
# and key filenames). This script therefore appends exactly one block, and only
# if that Host is absent -- the rest of the file is left untouched.
step "~/.ssh/config: Host linux"
if [ "$WRITE_SSH_CONFIG" -eq 0 ]; then
  ok "skipped (--no-ssh-config)"
elif [ -f "$HOME/.ssh/config" ] && grep -Eq '^[[:space:]]*[Hh]ost[[:space:]]+linux([[:space:]]|$)' "$HOME/.ssh/config"; then
  ok "'Host linux' already present"
else
  cat >>"$HOME/.ssh/config" <<EOF

# Added by dotfiles/wsl/setup-ssh.sh. Herdr's \`linux\` machine: sshd binds
# 0.0.0.0:$SSH_PORT and 127.0.0.1 inside the distro is the distro itself, so this
# one entry works from Windows and from inside WSL alike. accept-new, not no:
# it records the key on first connect and verifies it afterwards.
Host linux
    HostName 127.0.0.1
    User $SSH_USER
    Port $SSH_PORT
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    ServerAliveInterval 60
    ServerAliveCountMax 3
EOF
  ok "appended"
fi
chmod 600 "$HOME/.ssh/config" 2>/dev/null || true

# ------------------------------------------------------------------------------
# 8. Verify the actual path, not just the config files
# ------------------------------------------------------------------------------
step "Verifying"
sleep 1
if systemctl show ssh.socket -p Listen | grep -q ":$SSH_PORT"; then
  ok "listening on :$SSH_PORT"
else
  echo "    ssh.socket is not listening on :$SSH_PORT" >&2
  systemctl status ssh.socket --no-pager >&2 || true
  exit 1
fi

# Socket activation means ssh.service is not running yet by design. One real
# connection is the only way to prove the path end to end, so make one.
if timeout 15 ssh -o BatchMode=yes -o ConnectTimeout=8 linux "true" 2>/dev/null; then
  ok "ssh linux -- BatchMode login succeeded"
else
  echo "    'ssh linux' did not complete a login." >&2
  echo "    Expected when authorized_keys holds no matching key -- run:" >&2
  echo "      ssh -i ~/.ssh/id_ed25519 -p $SSH_PORT $SSH_USER@127.0.0.1 true" >&2
fi

# ------------------------------------------------------------------------------
# 9. What only Windows can do
# ------------------------------------------------------------------------------
WSL_CONF_WIN='[general]
instanceIdleTimeout=-1

[wsl2]
vmIdleTimeout=-1
localhostforwarding=true'

cat <<EOF

$(printf '\033[1m==> Windows side (run these in PowerShell, not here)\033[0m')

Herdr reaches this distro over sshd, so a distro that WSL shuts down when the
last process exits is a machine herdr reconnects to forever. Stop that, and let
Windows reach the listener on 127.0.0.1 instead of the reassigned NAT IP:

  notepad \$env:USERPROFILE\\.wslconfig

$WSL_CONF_WIN

Then, once, so .wslconfig and the systemd setting both take effect:

  wsl --shutdown

Register the machine with herdr (Windows client):

  herdr machine add linux --label linux

  With [remote] manage_ssh_config = true, herdr maintains the 'linux' entry in
  the Windows ~/.ssh/config. If it is already there, keep it -- it must be
  HostName 127.0.0.1, Port $SSH_PORT. Do not point it at 172.x.x.x: WSL reassigns
  that address on every reboot, which is what left herdr reconnecting to a dead
  IP before.

Check it from Windows:

  ssh linux
EOF
