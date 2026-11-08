#!/usr/bin/env bash
# ==============================================================================
# tailnet-t3.sh - Tailscale up, headless T3 Code as a systemd user service, and
# the environment published on the tailnet over Serve. Idempotent; safe to
# re-run.
#
#   bash scripts/tailnet-t3.sh
#   bash scripts/tailnet-t3.sh --port 3773 --check
#
# Run by install.sh's tailnet section, and runnable on its own: every step is a
# check-then-act on machine state, and the steps that need root say so.
#
# Why Serve rather than T3 Connect: Connect caps a free account at three
# machines and this fleet is five, so the private network is Tailscale's job and
# Serve puts the server behind a real HTTPS certificate on a MagicDNS name.
#
# Three failures this script exists to prevent, all found on a fresh host:
#
#   1. Tailscale's own resolver upstream was a peer that no longer exists, so
#      public names (github.com, acme-v02.api.letsencrypt.org) resolved to
#      nothing. That breaks the apt install, the t3 installer and the ACME fetch
#      behind the Serve certificate, which then fails the TLS handshake with a
#      certificate error rather than a DNS one. Fix: turn off accept-dns and pin
#      the tailnet names into /etc/hosts, which is all MagicDNS was wanted for.
#   2. A fresh host has no ~/.t3/userdata/settings.json, and linked environments
#      default to off. Pairing from the desktop is then refused with "Linked
#      environments is off on that machine" even though the server is healthy.
#   3. `tailscale serve` writes to tailscaled's own store, so without the
#      operator set it needs root, and `t3 pair --tailscale` shells out to it
#      without sudo and fails with TailscaleServeFailedError. The operator is
#      set below, so `t3 pair --tailscale` works here; Serve is still configured
#      up front so a plain `t3 pair` has something to pair against.
# ==============================================================================
set -euo pipefail

PORT=3773
CHECK_ONLY=0

log_step() { printf "\n\033[1;32m==> %s\033[0m\n" "$*"; }
log_info() { printf '   \033[0;36m->\033[0m %s\n' "$*"; }
log_ok()   { printf '   \033[1;32m[ok]\033[0m   %s\n' "$*"; }
log_warn() { printf '   \033[1;33m[warn]\033[0m %s\n' "$*"; }
log_err()  { printf '   \033[1;31m[err]\033[0m  %s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)    PORT="$2"; shift 2 ;;
    --check)   CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    *)         log_err "unknown option: $1"; exit 1 ;;
  esac
done

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# The tailnet name and every peer's address, as "ip name" lines.
#
# python3 rather than grep over the JSON: peers are objects with a DNSName and a
# TailscaleIPs array, and scraping that out of the raw text pairs a name with the
# wrong address as soon as the field order changes.
tailnet_hosts() {
  python3 - <<'PY' 2>/dev/null || true
import json, subprocess, sys
try:
    st = json.loads(subprocess.run(["tailscale", "status", "--json"],
                                   capture_output=True, text=True).stdout)
except Exception:
    sys.exit(0)
nodes = list((st.get("Peer") or {}).values())
if st.get("Self"):
    nodes.append(st["Self"])
for n in nodes:
    dns = (n.get("DNSName") or "").rstrip(".")
    ips = [i for i in (n.get("TailscaleIPs") or []) if ":" not in i]
    if dns and ips:
        print(f'{ips[0]} {dns}')
PY
}

this_dns() {
  python3 - <<'PY' 2>/dev/null || true
import json, subprocess
try:
    st = json.loads(subprocess.run(["tailscale", "status", "--json"],
                                   capture_output=True, text=True).stdout)
    print((st.get("Self") or {}).get("DNSName", "").rstrip("."))
except Exception:
    pass
PY
}

backend_state() {
  python3 - <<'PY' 2>/dev/null || true
import json, subprocess
try:
    st = json.loads(subprocess.run(["tailscale", "status", "--json"],
                                   capture_output=True, text=True).stdout)
    print(st.get("BackendState", ""))
except Exception:
    pass
PY
}

# ------------------------------------------------------------------------------
# 1. Tailscale from Tailscale's own apt repository.
#
# Not Ubuntu's: the archive build lags releases by months, and Serve and certs
# have changed more than once in that window. The key is fetched every run and
# only written when it differs, so a rotated key heals on the next run.
# ------------------------------------------------------------------------------
install_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    log_ok "tailscale present ($(tailscale version 2>/dev/null | head -1))"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log_warn "tailscale not installed (--check)"
    return 0
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    log_err "apt-get not found; this script targets Debian/Ubuntu"
    return 0
  fi

  local codename keyring tmp
  codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  [ -n "$codename" ] || codename="stable"
  keyring=/usr/share/keyrings/tailscale-archive-keyring.gpg

  log_info "adding the Tailscale apt repository (${codename})"
  tmp="$(mktemp)"
  if ! curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.noarmor.gpg" -o "$tmp"; then
    # A release upstream has no key file for is a repository gap, not a reason
    # to stop: the `stable` suite serves every supported release.
    log_warn "no key for ${codename}; falling back to the stable suite"
    codename=stable
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/stable.noarmor.gpg" -o "$tmp"
  fi
  if $SUDO cmp -s "$tmp" "$keyring"; then
    log_ok "tailscale repo key already current"
    rm -f "$tmp"
  else
    $SUDO install -D -m 0644 "$tmp" "$keyring"
    rm -f "$tmp"
    log_ok "tailscale repo key installed"
  fi

  echo "deb [signed-by=${keyring}] https://pkgs.tailscale.com/stable/ubuntu ${codename} main" \
    | $SUDO tee /etc/apt/sources.list.d/tailscale.list >/dev/null

  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq tailscale
  log_ok "tailscale installed ($(tailscale version 2>/dev/null | head -1))"
}

# ------------------------------------------------------------------------------
# 2. The daemon, its resolver behaviour, and Serve's permissions.
# ------------------------------------------------------------------------------
configure_tailscaled() {
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log_info "would ensure tailscaled is enabled and running"
    return 0
  fi
  $SUDO systemctl enable --now tailscaled >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet tailscaled; then
    log_warn "tailscaled is not running; check: journalctl -u tailscaled -n 30"
    return 0
  fi
  log_ok "tailscaled running"

  # Serve writes to tailscaled's store, so the operator is what lets it run as
  # the normal user instead of needing sudo for every call.
  if [ -n "$SUDO" ] && ! tailscale debug prefs 2>/dev/null | grep -q "\"OperatorUser\": \"$USER\""; then
    $SUDO tailscale set --operator="$USER" >/dev/null 2>&1 \
      || log_warn "could not set the Serve operator; run: sudo tailscale set --operator=$USER"
  fi

  if [ "$(tailscale debug prefs 2>/dev/null | grep -o '"CorpDNS": [a-z]*' | awk '{print $2}')" != "false" ]; then
    log_info "turning off Tailscale's DNS delegation (its upstream has been dead on this fleet)"
    $SUDO tailscale set --accept-dns=false >/dev/null 2>&1 \
      || log_warn "could not disable accept-dns; run: sudo tailscale set --accept-dns=false"
  else
    log_ok "Tailscale DNS delegation already off"
  fi

  # Pin every tailnet name, so they keep resolving without the tailnet resolver.
  # Only names that are missing or point elsewhere are appended.
  if [ "$(backend_state)" = "Running" ]; then
    local ip name added=0
    while read -r ip name; do
      [ -n "$ip" ] && [ -n "$name" ] || continue
      if grep -qE "^[0-9.]+[[:space:]]+${name//./\\.}([[:space:]]|$)" /etc/hosts 2>/dev/null \
         || grep -qE "^${ip}[[:space:]]+${name//./\\.}([[:space:]]|$)" /etc/hosts 2>/dev/null; then
        continue
      fi
      echo "${ip} ${name}" | $SUDO tee -a /etc/hosts >/dev/null
      added=$((added + 1))
    done < <(tailnet_hosts)
    if [ "$added" -gt 0 ]; then
      log_ok "pinned $added tailnet name(s) in /etc/hosts"
    else
      log_ok "tailnet names already pinned in /etc/hosts"
    fi
  fi
}

# ------------------------------------------------------------------------------
# 3. Sign-in. `tailscale up` opens a browser, or prints a URL over SSH. That is
# a person's step, so it is reported and the rest is skipped until it is done.
# ------------------------------------------------------------------------------
check_login() {
  local state
  state="$(backend_state)"
  if [ "$state" != "Running" ]; then
    log_warn "Tailscale is not signed in (state: ${state:-unknown})"
    log_info "Sign in once:  sudo tailscale up"
    log_info "Then re-run this script to install the T3 server and publish it."
    return 1
  fi
  log_ok "Tailscale signed in as $(this_dns)"
  return 0
}

# ------------------------------------------------------------------------------
# 4. T3 Code: the nightly CLI, the user service, and the access settings.
#
# Nightly because the desktop app tracks nightly, and a server on another
# channel is refused at connect time on the orchestration protocol version.
# ------------------------------------------------------------------------------
install_t3() {
  export PATH="$HOME/.local/bin:$PATH"

  if command -v t3 >/dev/null 2>&1; then
    log_ok "t3 present ($(t3 --version 2>/dev/null | head -1))"
    if [ "$CHECK_ONLY" -eq 0 ]; then
      t3 update --yes >/dev/null 2>&1 || log_warn "t3 update reported an error; continuing"
    fi
  elif [ "$CHECK_ONLY" -eq 1 ]; then
    log_warn "t3 not installed (--check)"
    return 0
  else
    log_info "installing the T3 Code CLI (nightly)"
    if ! curl -fsSL https://t3.codes/install.sh | T3CODE_CHANNEL=nightly sh; then
      log_err "t3 install failed"
      return 0
    fi
    export PATH="$HOME/.local/bin:$PATH"
    command -v t3 >/dev/null 2>&1 || { log_err "t3 installed but not on PATH (~/.local/bin)"; return 0; }
    log_ok "t3 installed ($(t3 --version 2>/dev/null | head -1))"
  fi

  if [ "$CHECK_ONLY" -eq 1 ]; then
    log_info "would install the user service and set LAN + tailnet access"
  else
    t3 service install >/dev/null 2>&1 || log_warn "t3 service install reported an error"
    if systemctl --user is-enabled --quiet t3code.service 2>/dev/null; then
      log_ok "t3code user service enabled"
    else
      log_warn "t3code user service not enabled; run: t3 service install"
    fi

    # LAN + tailnet, no T3 Connect. --yes keeps the existing settings and must
    # not prompt: this runs from an installer with nobody at the keyboard.
    t3 up --no-connect --lan --yes >/dev/null 2>&1 || log_warn "t3 up reported an error"

    # Linked environments is off until something writes it, and a fresh machine
    # has no settings.json at all. Without this, pairing is refused with "Linked
    # environments is off on that machine" while the server itself is healthy.
    local settings="$HOME/.t3/userdata/settings.json"
    if command -v node >/dev/null 2>&1; then
      mkdir -p "$HOME/.t3/userdata"
      local rc=0
      node -e '
        const fs = require("fs");
        const p = process.argv[1];
        let s = {};
        try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
        const before = JSON.stringify(s);
        if (s.linkedEnvironmentsEnabled !== true) s.linkedEnvironmentsEnabled = true;
        if (!s.providerInstances || Object.keys(s.providerInstances).length === 0) {
          s.providerInstances = {
            opencode: { driver: "opencode", enabled: true,
                        config: { serverUrl: "", serverPassword: "", customModels: [] } },
            pi: { driver: "pi", displayName: "Pi", enabled: true }
          };
        }
        if (!s.defaultModelSelection) {
          s.defaultModelSelection = { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" };
        }
        if (JSON.stringify(s) === before) process.exit(0);
        fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
        process.exit(10);
      ' "$settings" || rc=$?
      if [ "$rc" -eq 10 ]; then
        log_ok "settings.json: linked environments on, providers declared"
        systemctl --user restart t3code.service >/dev/null 2>&1 || true
      elif [ "$rc" -eq 0 ]; then
        log_ok "settings.json already enables linked environments"
      else
        log_warn "could not update $settings"
      fi
    else
      log_warn "node not found; set linkedEnvironmentsEnabled by hand in $settings"
    fi
  fi

  # Provider credentials live in opencode's own SQLite database now, not in
  # auth.json, and a host with none answers every turn with "Free usage limit
  # reached". They are secrets, so this reports rather than copies them.
  if command -v opencode >/dev/null 2>&1; then
    if opencode auth list 2>/dev/null | grep -qi stored; then
      log_ok "opencode has provider credentials"
    else
      log_warn "opencode has no provider credentials; agents here fail on free-tier limits"
      log_info "Run 'opencode auth login', or copy the credential rows from another host's"
      log_info "  ~/.local/share/opencode/opencode.db (table: credential)"
    fi
  else
    log_warn "opencode not on PATH; its credentials cannot be checked"
  fi
}

# ------------------------------------------------------------------------------
# 5. Serve. Compared by target, not by presence: an entry pointed at an old port
# looks configured and never corrects itself.
# ------------------------------------------------------------------------------
configure_serve() {
  local dns want current
  dns="$(this_dns)"
  if [ -z "$dns" ]; then
    log_warn "could not read this machine's tailnet name; skipping Serve"
    return 0
  fi
  want="http://127.0.0.1:${PORT}"
  # tailscaled writes `"Proxy": "http://..."` with a space; accept either form,
  # and never let a no-match pipeline fail the script under set -e.
  current="$(tailscale serve status --json 2>/dev/null \
    | sed -n 's/.*"Proxy":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)" || current=""

  if [ "$current" = "$want" ]; then
    log_ok "Serve publishes $want at https://${dns}/"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    log_info "would publish $want at https://${dns}/ (currently: ${current:-none})"
    return 0
  fi

  if tailscale serve --bg "$want" >/dev/null 2>&1; then
    log_ok "Serve publishes $want at https://${dns}/"
  elif [ -n "$SUDO" ] && $SUDO tailscale serve --bg "$want" >/dev/null 2>&1; then
    log_ok "Serve publishes $want at https://${dns}/ (via sudo)"
  else
    log_warn "tailscale serve failed; run by hand: tailscale serve --bg $want"
  fi
}

# ------------------------------------------------------------------------------
# 6. Does the server actually answer? A Serve entry in front of a dead port is
# indistinguishable from a working one until someone opens the app.
# ------------------------------------------------------------------------------
check_server() {
  local code
  code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:${PORT}/.well-known/t3/environment" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    log_ok "T3 environment answering on 127.0.0.1:${PORT}"
  else
    log_warn "nothing answers on 127.0.0.1:${PORT} (http: ${code:-none})"
    log_info "Check: systemctl --user status t3code; journalctl --user -u t3code -n 30"
  fi
}

log_step "Tailnet + T3 Code"
install_tailscale
if command -v tailscale >/dev/null 2>&1; then
  configure_tailscaled
  if check_login; then
    install_t3
    configure_serve
    check_server
    log_info "Pair a device with: t3 pair --ttl 24h --label \"<device>\""
    log_info "Then add it in Settings -> Environments as https://<host>.ts.net"
  fi
fi
log_ok "Tailnet + T3 Code step complete."
