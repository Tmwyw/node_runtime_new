#!/usr/bin/env bash
set -euo pipefail

NETRUN_HOME="/opt/netrun"
PROXY_ROOT="/opt/netrun/proxyserver"
JOBS_ROOT="/opt/netrun/jobs"
SERVICE_NAME="netrun-node-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SYSCTL_FILE="/etc/sysctl.d/99-netrun.conf"
LIMITS_FILE="/etc/security/limits.d/99-netrun.conf"
RESOLV_CONF="/etc/resolv.conf"
RESTORE_SERVICE_NAME="netrun-3proxy-restore"
RESTORE_SERVICE_FILE="/etc/systemd/system/${RESTORE_SERVICE_NAME}.service"
RESTORE_SCRIPT="/opt/netrun/scripts/restore-3proxy.sh"
DOCTOR_SCRIPT="/opt/netrun/scripts/netrun-doctor.sh"
HEALTH_URL="http://127.0.0.1:8085/health"

CLEAN_REQUESTED=0
REMOVE_LEGACY_ROOT=0
TMP_SOURCE=""

log() {
  printf '[install_node] %s\n' "$*"
}

die() {
  printf '[install_node] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bash install_node.sh [--clean] [--remove-legacy-root]

Options:
  --clean               Run scripts/clean_node.sh before installing.
  --remove-legacy-root  With --clean, also remove /root/proxyserver.
EOF
}

cleanup_tmp() {
  if [ -n "$TMP_SOURCE" ] && [ -d "$TMP_SOURCE" ]; then
    rm -rf "$TMP_SOURCE"
  fi
}
trap cleanup_tmp EXIT

for arg in "$@"; do
  case "$arg" in
    --clean)
      CLEAN_REQUESTED=1
      ;;
    --remove-legacy-root)
      REMOVE_LEGACY_ROOT=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $arg"
      ;;
  esac
done

if [ "${EUID}" -ne 0 ]; then
  die "must_run_as_root"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_DIR="$SCRIPT_DIR"

ensure_bundled_3proxy() {
  local root="$1"
  local binary="$root/deploy/node/bin/3proxy"
  if [ ! -f "$binary" ]; then
    die "missing_bundled_3proxy_binary: expected $binary"
  fi
}

copy_source_to_tmp() {
  TMP_SOURCE="$(mktemp -d /tmp/netrun-node-source.XXXXXX)"
  tar -C "$SOURCE_DIR" --exclude='./.git' -cf - . | tar -C "$TMP_SOURCE" -xpf -
  SOURCE_DIR="$TMP_SOURCE"
}

run_clean_if_requested() {
  if [ "$CLEAN_REQUESTED" -ne 1 ]; then
    return 0
  fi

  local source_real
  source_real="$(realpath "$SOURCE_DIR")"
  if [ "$source_real" = "$NETRUN_HOME" ] || [[ "$source_real" == "$NETRUN_HOME/"* ]]; then
    copy_source_to_tmp
  fi

  local clean_script="$SOURCE_DIR/scripts/clean_node.sh"
  [ -f "$clean_script" ] || die "clean_script_not_found: $clean_script"
  chmod +x "$clean_script" || true

  log "Running cleanup before install"
  if [ "$REMOVE_LEGACY_ROOT" -eq 1 ]; then
    bash "$clean_script" --remove-legacy-root
  else
    bash "$clean_script"
  fi
}

install_os_dependencies() {
  command -v apt-get >/dev/null 2>&1 || die "apt_get_not_found"
  export DEBIAN_FRONTEND=noninteractive
  log "Installing OS dependencies"
  apt-get update
  apt-get install -y curl wget jq ca-certificates nftables
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

install_nodejs_20_if_needed() {
  local major
  major="$(node_major)"
  if [ "$major" -ge 20 ] 2>/dev/null; then
    log "Node.js major version is $major"
  else
    export DEBIAN_FRONTEND=noninteractive
    log "Installing Node.js 20"
    apt-get install -y ca-certificates curl gnupg
    mkdir -p /etc/apt/keyrings
    rm -f /etc/apt/keyrings/nodesource.gpg
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    chmod 0644 /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update
    apt-get install -y nodejs
  fi

  if [ ! -x /usr/bin/node ]; then
    local node_bin
    node_bin="$(command -v node || true)"
    [ -n "$node_bin" ] || die "node_binary_not_found_after_install"
    ln -sf "$node_bin" /usr/bin/node
  fi

  local final_major
  final_major="$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "$final_major" -ge 20 ] 2>/dev/null || die "nodejs_20_required"
}

copy_repo_to_opt() {
  mkdir -p "$NETRUN_HOME"
  local source_real
  source_real="$(realpath "$SOURCE_DIR")"
  if [ "$source_real" = "$NETRUN_HOME" ]; then
    log "Using existing repo at $NETRUN_HOME"
    return 0
  fi

  log "Copying node runtime to $NETRUN_HOME"
  tar -C "$SOURCE_DIR" --exclude='./.git' -cf - . | tar -C "$NETRUN_HOME" -xpf -
}

install_runtime_files() {
  mkdir -p "$NETRUN_HOME" "$JOBS_ROOT" "$PROXY_ROOT" "$PROXY_ROOT/3proxy/bin"

  local bundled="$NETRUN_HOME/deploy/node/bin/3proxy"
  [ -f "$bundled" ] || die "missing_bundled_3proxy_binary: expected $bundled"

  install -m 0755 "$bundled" "$PROXY_ROOT/3proxy/bin/3proxy"
  chmod +x "$PROXY_ROOT/3proxy/bin/3proxy"
  chmod +x "$NETRUN_HOME/node_runtime/generator/proxyyy_automated.sh"
  chmod +x "$NETRUN_HOME/node_runtime/soft/generator/proxyyy_automated.sh"
  chmod +x "$NETRUN_HOME/scripts/"*.sh
}

configure_sysctl() {
  log "Configuring sysctl (IPv6 forwarding + high-connection tuning)"
  cat > "$SYSCTL_FILE" <<'EOF'
# === IPv6 forwarding (required for nftables accounting + 3proxy IPv6 egress) ===
net.ipv6.ip_nonlocal_bind = 1
net.ipv6.conf.all.forwarding = 1
net.ipv6.conf.default.forwarding = 1

# === High-connection tuning (5000+ concurrent SOCKS5 sessions) ===
# Conntrack table: default ~256k saturates around 4000 active proxies.
# 1M entries handles 100k+ concurrent without deadlock.
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_tcp_timeout_established = 7200

# TCP backlog: handle bursts of new connections without dropping.
net.ipv4.tcp_max_syn_backlog = 8192
net.core.somaxconn = 8192

# Local port range: 10000-65000 (preserves <10000 for 3proxy listeners,
# matches our 30000-46000 generation range with margin).
net.ipv4.ip_local_port_range = 10000 65000

# Filesystem: 2M open file descriptors (default 1M often capped).
fs.file-max = 2097152

# Don't reverse path filter on multi-homed IPv6 (Vultr's link-local quirks).
net.ipv6.conf.all.accept_ra = 2
net.ipv6.conf.default.accept_ra = 2
EOF
  sysctl -p "$SYSCTL_FILE" >/dev/null
}

configure_file_limits() {
  log "Configuring file descriptor limits (1M open FDs)"
  cat > "$LIMITS_FILE" <<'EOF'
# NETRUN: each 3proxy instance opens 2-4 FDs per active client connection.
# 1M FDs handles ~250k concurrent clients per node.
root soft nofile 1048576
root hard nofile 1048576
* soft nofile 1048576
* hard nofile 1048576
EOF
  # Also set for current session systemd uses
  if [ -d /etc/systemd/system.conf.d ]; then
    cat > /etc/systemd/system.conf.d/99-netrun-limits.conf <<'EOF'
[Manager]
DefaultLimitNOFILE=1048576
EOF
  fi
}

disable_ufw() {
  log "Removing UFW (nftables handles real traffic filtering; UFW default-deny breaks high-port ranges after reboot)"
  if command -v ufw >/dev/null 2>&1; then
    ufw --force disable 2>/dev/null || true
    apt-get purge -y ufw 2>/dev/null || true
  fi
  # Also mask the service so it can never auto-start again
  systemctl mask ufw 2>/dev/null || true
}

configure_colored_prompt() {
  # Adds a coloured PS1 to /root/.bashrc so the hostname stands out
  # in SSH sessions (operators flag this constantly when juggling 5+ nodes).
  # Bright green (\033[01;32m) hostname, bright blue (\033[01;34m) cwd.
  log "Setting up coloured root prompt"
  local bashrc="/root/.bashrc"
  if [ -f "$bashrc" ] && grep -q "NETRUN colored prompt" "$bashrc"; then
    return 0  # Already installed
  fi
  cat >> "$bashrc" <<'EOF'

# === NETRUN colored prompt — bright green hostname for visual ID ===
export PS1='\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
EOF
}

pin_dns_resolvers() {
  log "Pinning /etc/resolv.conf to public resolvers (Vultr regional DNS unreliable per-DC)"
  # Remove immutable flag if set from prior runs
  chattr -i "$RESOLV_CONF" 2>/dev/null || true
  cat > "$RESOLV_CONF" <<'EOF'
# NETRUN: pinned to Cloudflare + Google + IPv6 equivalents.
# Vultr's regional DNS (108.61.10.10 / 2001:19f0:300:1704::6) is unreliable
# in some DCs (notably Mumbai); UDP-53 hangs intermittently.
nameserver 1.1.1.1
nameserver 8.8.8.8
nameserver 2606:4700:4700::1111
nameserver 2001:4860:4860::8888
options edns0 trust-ad timeout:2 attempts:1
EOF
  # Lock against cloud-init / netplan / systemd-resolved rewriting it on boot
  chattr +i "$RESOLV_CONF" 2>/dev/null || true
}

configure_nftables() {
  log "Configuring nftables"
  systemctl enable nftables >/dev/null
  systemctl start nftables >/dev/null

  nft add table inet proxy_normalization 2>/dev/null || true
  nft add chain inet proxy_normalization output '{ type filter hook output priority -150; policy accept; }' 2>/dev/null || true
  nft add chain inet proxy_normalization postrouting '{ type filter hook postrouting priority -150; policy accept; }' 2>/dev/null || true

  nft add table inet proxy_accounting 2>/dev/null || true
  nft add chain inet proxy_accounting input '{ type filter hook input priority 0; policy accept; }' 2>/dev/null || true
  nft add chain inet proxy_accounting output '{ type filter hook output priority 0; policy accept; }' 2>/dev/null || true

  # === TCP MSS clamping (Incident 2026-05-12) ===
  # Vultr/OVH inter-DC paths sometimes have PMTU < 1500 with ICMPv4
  # "Fragmentation Needed" blackholed. ServerHello packets >1380 bytes silently
  # drop → TLS handshakes timeout. Pin TCP MSS to 1340 (fits in 1380 PMTU
  # with 40 bytes IPv4+TCP overhead). Costs ~7% throughput on healthy 1500-MTU
  # paths, but eliminates the silent-TLS-failure failure mode entirely.
  nft add rule inet proxy_normalization output meta l4proto tcp tcp flags syn tcp option maxseg size set 1340 2>/dev/null || true

  nft list ruleset > /etc/nftables.conf
}

write_bootstrap_marker() {
  log "Writing bootstrap marker"
  cat > "$PROXY_ROOT/.netrun_bootstrap.json" <<EOF
{
  "bootstrapped_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "proxy_root": "$PROXY_ROOT",
  "jobs_root": "$JOBS_ROOT",
  "bundled_3proxy": "$NETRUN_HOME/deploy/node/bin/3proxy",
  "runtime_3proxy": "$PROXY_ROOT/3proxy/bin/3proxy",
  "installer": "install_node.sh"
}
EOF
}

ensure_legacy_root_proxyserver_symlink() {
  # proxyyy_automated.sh hardcodes /root/proxyserver/3proxy/bin/3proxy and
  # /root/proxyserver/.netrun_bootstrap.json as bootstrap-marker paths.
  # Without this symlink, the script logs BOOTSTRAP_NOT_READY and refill
  # fails with generator_exit_1 on every fresh node (incident 2026-05-12,
  # Frankfurt enrollment). Older nodes (Mumbai, Tokyo, ...) had this
  # symlink manually applied during the original incident recovery —
  # bake it into the installer so all new nodes get it from the start.
  log "Linking /root/proxyserver -> $PROXY_ROOT (legacy script compat)"
  if [ -e /root/proxyserver ] && [ ! -L /root/proxyserver ]; then
    log "WARNING: /root/proxyserver exists as a directory, leaving alone"
    return 0
  fi
  ln -sfn "$PROXY_ROOT" /root/proxyserver
}

install_systemd_service() {
  local template="$NETRUN_HOME/deploy/node/netrun-node-agent.service.template"
  [ -f "$template" ] || die "service_template_not_found: $template"

  log "Installing systemd service"
  install -m 0644 "$template" "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"
}

install_3proxy_restore_unit() {
  # On reboot, node-agent does NOT auto-respawn 3proxy from existing cfg files
  # (it only spawns on POST /generate from orchestrator). Without this oneshot,
  # all proxies die after every reboot and orchestrator's DB drifts vs disk.
  log "Installing 3proxy auto-restore systemd unit"
  mkdir -p "$(dirname "$RESTORE_SCRIPT")"
  cat > "$RESTORE_SCRIPT" <<'RESTORESH'
#!/usr/bin/env bash
# Respawn 3proxy for every saved cfg file in /opt/netrun/proxyserver/3proxy/.
# Runs once on boot via netrun-3proxy-restore.service.
set -u

PROXY_BIN="/opt/netrun/proxyserver/3proxy/bin/3proxy"
PROXY_CFG_DIR="/opt/netrun/proxyserver/3proxy"
LOG_TAG="netrun-3proxy-restore"

if [ ! -x "$PROXY_BIN" ]; then
  logger -t "$LOG_TAG" "skip: 3proxy binary not found at $PROXY_BIN"
  exit 0
fi

shopt -s nullglob
started=0
already=0
failed=0

for cfg in "$PROXY_CFG_DIR"/3proxy_*.cfg; do
  [ -f "$cfg" ] || continue
  port=$(basename "$cfg" .cfg | sed 's/3proxy_//')
  # Skip if a process is already listening on this port
  if ss -tln 2>/dev/null | grep -q ":${port} "; then
    already=$((already + 1))
    continue
  fi
  # Start in background, detached
  "$PROXY_BIN" "$cfg" </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  started=$((started + 1))
done

# Brief settle then count actual listeners (sanity check)
sleep 2
active=$(ss -tln 2>/dev/null | grep -cE ':[1-9][0-9]{3,4} ' || echo 0)
logger -t "$LOG_TAG" "restored started=$started already=$already total_listening=$active"
exit 0
RESTORESH
  chmod +x "$RESTORE_SCRIPT"

  cat > "$RESTORE_SERVICE_FILE" <<EOF
[Unit]
Description=NETRUN — restore all 3proxy instances from saved cfg files
Documentation=https://github.com/Tmwyw/node_runtime
After=network-online.target ${SERVICE_NAME}.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${RESTORE_SCRIPT}
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$RESTORE_SERVICE_NAME" >/dev/null
  # Don't start it now — node-agent already manages live proxies
  # On reboot, this service kicks in automatically.
}

install_doctor_script() {
  log "Installing netrun-doctor.sh (one-command diagnostics)"
  cat > "$DOCTOR_SCRIPT" <<'DOCTOR'
#!/usr/bin/env bash
# NETRUN node health summary. Run on any node:
#   bash /opt/netrun/scripts/netrun-doctor.sh
set -u

c() { echo -e "\n\033[1;36m=== $* ===\033[0m"; }
ok() { echo -e "  \033[32m✓\033[0m $*"; }
warn() { echo -e "  \033[33m⚠\033[0m $*"; }
fail() { echo -e "  \033[31m✗\033[0m $*"; }

c "1. System"
echo "  hostname:      $(hostname)"
echo "  uptime:        $(uptime -p)"
echo "  kernel:        $(uname -r)"

c "2. Network — DNS"
if [ -f /etc/resolv.conf ]; then
  if lsattr /etc/resolv.conf 2>/dev/null | grep -q 'i'; then
    ok "/etc/resolv.conf is immutable (won't be reset by cloud-init)"
  else
    warn "/etc/resolv.conf is NOT immutable — Vultr/cloud-init may overwrite on reboot"
  fi
  echo "  nameservers:"
  grep -E '^nameserver' /etc/resolv.conf | sed 's/^/    /'
fi
if timeout 3 curl -fsSL -o /dev/null https://1.1.1.1 2>/dev/null; then ok "DNS resolution + outbound HTTPS works"; else fail "DNS or outbound HTTPS fails"; fi

c "3. Firewall"
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -qi 'inactive'; then
    ok "ufw installed but inactive"
  else
    fail "UFW IS ACTIVE — will block node-agent + proxy ports after any reboot!"
  fi
else
  ok "ufw not installed (correct)"
fi

c "4. nftables (accounting)"
if systemctl is-active --quiet nftables; then
  ok "nftables active"
  rules=$(nft list ruleset 2>/dev/null | wc -l)
  echo "  ruleset lines: $rules"
else
  fail "nftables NOT active — accounting won't work"
fi

c "5. sysctl"
for key in net.netfilter.nf_conntrack_max fs.file-max net.ipv6.conf.all.forwarding; do
  val=$(sysctl -n "$key" 2>/dev/null || echo "?")
  echo "  $key = $val"
done
conntrack_used=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 0)
conntrack_max=$(sysctl -n net.netfilter.nf_conntrack_max 2>/dev/null || echo 1)
pct=$((conntrack_used * 100 / conntrack_max))
if [ "$pct" -ge 70 ]; then fail "conntrack at ${pct}% (${conntrack_used}/${conntrack_max}) — risk of deadlock"; else ok "conntrack at ${pct}% (${conntrack_used}/${conntrack_max})"; fi

c "6. node-agent service"
if systemctl is-active --quiet netrun-node-agent; then
  ok "netrun-node-agent active"
  health=$(curl -m 3 -fsS http://127.0.0.1:8085/health 2>/dev/null || echo '{}')
  if echo "$health" | grep -q '"success":true'; then
    instances=$(echo "$health" | grep -oE '"activeInstances":[0-9]+' | sed 's/.*://')
    ipv6_ok=$(echo "$health" | grep -oE '"ipv6":{"ok":(true|false)' | sed 's/.*ok"://')
    ok "agent /health: instances=$instances ipv6=$ipv6_ok"
  else
    fail "agent /health returns malformed response"
  fi
else
  fail "netrun-node-agent NOT active"
fi

c "7. 3proxy restore unit"
if systemctl is-enabled --quiet netrun-3proxy-restore 2>/dev/null; then
  ok "netrun-3proxy-restore.service enabled (will respawn 3proxy on boot)"
else
  warn "netrun-3proxy-restore NOT enabled — proxies will die after reboot"
fi

c "8. 3proxy state"
cfg_count=$(ls /opt/netrun/proxyserver/3proxy/3proxy_*.cfg 2>/dev/null | wc -l)
proc_count=$(pgrep -c 3proxy 2>/dev/null || echo 0)
listening=$(ss -tln 2>/dev/null | grep -cE ':[3-4][0-9]{4} ' || echo 0)
echo "  cfg files:       $cfg_count"
echo "  3proxy procs:    $proc_count"
echo "  proxy listeners: $listening"
if [ "$cfg_count" -gt 0 ] && [ "$proc_count" -lt "$cfg_count" ]; then
  warn "cfg files ($cfg_count) > running procs ($proc_count) — drift; run /opt/netrun/scripts/restore-3proxy.sh"
elif [ "$cfg_count" -eq 0 ]; then
  warn "no 3proxy cfg files — node is empty, awaiting refill"
else
  ok "cfg vs procs in sync"
fi

c "9. Resources"
echo "  load:    $(cut -d' ' -f1-3 /proc/loadavg)"
echo "  mem:     $(free -h | awk '/^Mem:/ {print $3"/"$2" used"}')"
echo "  disk /:  $(df -h / | awk 'NR==2 {print $5" used of "$2}')"
fds=$(ls /proc/$(pgrep -f node-agent || echo 1)/fd 2>/dev/null | wc -l)
[ "$fds" -gt 0 ] && echo "  node-agent FDs: $fds"

echo -e "\n\033[1;32mAll checks done.\033[0m"
DOCTOR
  chmod +x "$DOCTOR_SCRIPT"
}

verify_health() {
  log "Waiting for health ready"
  local health=""
  for _ in $(seq 1 30); do
    health="$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)"
    if [ -n "$health" ] && printf '%s' "$health" | jq -e '.success == true and .status == "ready"' >/dev/null 2>&1; then
      printf '%s\n' "$health" | jq .
      return 0
    fi
    sleep 1
  done

  systemctl status "$SERVICE_NAME" --no-pager || true
  journalctl -u "$SERVICE_NAME" -n 100 --no-pager || true
  die "health_check_failed"
}

main() {
  ensure_bundled_3proxy "$SOURCE_DIR"
  run_clean_if_requested
  ensure_bundled_3proxy "$SOURCE_DIR"

  # === Hardening (run BEFORE installing node-agent) ===
  # Anti-recurrence of 2026-05-12 incident:
  #  - UFW reset to default-deny on reboot → blocked node-agent + 3proxy ports
  #  - Vultr regional DNS unreliable per-DC → node-agent IPv6 health-checks hung
  #  - Default kernel limits saturated under 5000+ concurrent proxy sessions
  disable_ufw
  pin_dns_resolvers
  configure_file_limits
  configure_colored_prompt

  install_os_dependencies
  install_nodejs_20_if_needed
  copy_repo_to_opt
  install_runtime_files
  configure_sysctl
  configure_nftables
  write_bootstrap_marker
  ensure_legacy_root_proxyserver_symlink
  install_systemd_service

  # === Boot-time auto-recovery (run AFTER node-agent so we know the binary works) ===
  install_3proxy_restore_unit
  install_doctor_script

  verify_health

  log "Install complete"
  log "NETRUN_HOME=$NETRUN_HOME"
  log "PROXY_ROOT=$PROXY_ROOT"
  log "JOBS_ROOT=$JOBS_ROOT"
  log "SERVICE=$SERVICE_NAME (active)"
  log "RESTORE_SERVICE=$RESTORE_SERVICE_NAME (enabled, fires on next reboot)"
  log "HEALTH=$HEALTH_URL"
  log "DOCTOR=$DOCTOR_SCRIPT  (run for one-command health summary)"
}

main "$@"
