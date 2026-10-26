#!/usr/bin/env bash
# Optional: an HTTP(S) forward proxy (tinyproxy) that only tailnet devices can use, e.g. Claude cloud sessions that
# have joined the tailnet. Run after setup-server.sh:
#   sudo bash deploy/setup-proxy.sh
# Listens on this server's Tailscale IPv4, port 8888. ufw already denies everything public except 80/443, and
# tinyproxy itself only accepts Tailscale source addresses. Safe to re-run. See deploy/README.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0"; exit 1; }
PORT=8888

TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
[[ $TS_IP =~ ^100\. ]] || { echo "tailscale is not up; run setup-server.sh first"; exit 1; }
PUBLIC_IP=$(curl -fsS4 --max-time 5 https://ifconfig.me || true)

echo "== tinyproxy"
apt-get install -y -qq tinyproxy >/dev/null

cat > /etc/tinyproxy/tinyproxy.conf <<EOF
# Managed by deploy/setup-proxy.sh
User tinyproxy
Group tinyproxy
Listen $TS_IP
Port $PORT
Timeout 600
MaxClients 100
LogLevel Info
Syslog On
DisableViaHeader Yes
# Only tailnet clients (Tailscale's CGNAT and IPv6 ranges).
Allow 100.64.0.0/10
Allow fd7a:115c:a1e0::/48
# HTTPS (CONNECT) to port 443 only. Plain HTTP is forwarded to any port.
ConnectPort 443
# Keep the proxy from reaching this server's private services or the tailnet (see the filter file).
Filter "/etc/tinyproxy/filter"
FilterType ere
FilterDefaultDeny No
EOF

cat > /etc/tinyproxy/filter <<'EOF'
# Hosts the proxy refuses (extended regex, matched against the host name). Managed by deploy/setup-proxy.sh
^[^.]+$
\.ts\.net$
\.internal$
\.local$
^100\.
^127\.
^0\.
EOF

# Second fence, enforced by the kernel for everything tinyproxy sends: no loopback (except the DNS stub), no
# link-local (Hetzner metadata), no private ranges (IPv6 ones include the tailnet), and not this server's own addresses.
mkdir -p /etc/systemd/system/tinyproxy.service.d
cat > /etc/systemd/system/tinyproxy.service.d/override.conf <<EOF
# Managed by deploy/setup-proxy.sh
[Unit]
# It binds the Tailscale IP, so start after tailscaled and retry until the address exists.
After=tailscaled.service network-online.target
Wants=tailscaled.service network-online.target
StartLimitIntervalSec=0

[Service]
Restart=on-failure
RestartSec=5
IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7 $TS_IP/32 ${PUBLIC_IP:+$PUBLIC_IP/32}
IPAddressAllow=127.0.0.53/32
EOF

systemctl daemon-reload
systemctl enable tinyproxy >/dev/null
systemctl restart tinyproxy
sleep 1
systemctl is-active --quiet tinyproxy || { journalctl -u tinyproxy -n 20 --no-pager; exit 1; }

echo
echo "Done. Proxy: http://$TS_IP:$PORT  (tailnet only)"
echo "Test from a tailnet device:  curl -x http://$TS_IP:$PORT https://ifconfig.me   (should print this server's public IP)"
