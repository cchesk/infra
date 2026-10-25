#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu/Debian box (e.g. Hetzner Cloud) that hosts any number of apps at
# https://<app>.<domain>. Deploys come from GitHub Actions over Tailscale SSH (.github/workflows/deploy-app.yml).
#   curl -fsSL https://raw.githubusercontent.com/cchesk/infra/main/deploy/setup-server.sh -o setup.sh
#   sudo bash setup.sh example.com
# Safe to re-run (e.g. to change the domain). See deploy/README.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0 <domain>"; exit 1; }
DOMAIN=${1:-$(cat /etc/apps/domain 2>/dev/null || true)}
[[ $DOMAIN =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "usage: sudo bash $0 <domain>   (e.g. example.com)"; exit 1; }
SRC=https://raw.githubusercontent.com/cchesk/infra/main/deploy

echo "== packages"
apt-get update -qq
apt-get install -y -qq curl rsync ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

echo "== deploy user, app registry, deploy helper"
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
mkdir -p /srv/apps /etc/apps /etc/caddy/apps
chown deploy:deploy /srv/apps
echo "$DOMAIN" > /etc/apps/domain
curl -fsSL "$SRC/app-deploy" -o /usr/local/bin/app-deploy
chmod 755 /usr/local/bin/app-deploy
# CI may run the deploy helper as root and nothing else.
echo "deploy ALL=(root) NOPASSWD: /usr/local/bin/app-deploy" > /etc/sudoers.d/apps
chmod 440 /etc/sudoers.d/apps

cat > /etc/systemd/system/app@.service <<'EOF'
[Unit]
Description=app %i
After=network-online.target
Wants=network-online.target

[Service]
User=deploy
WorkingDirectory=/srv/apps/%i/current
Environment=NODE_ENV=production
EnvironmentFile=/etc/apps/%i.env
# Your own secrets for the app (API keys etc.), one KEY=value per line. Never committed.
EnvironmentFile=-/srv/apps/%i/env.local
ExecStart=/bin/sh ./.app-start
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

echo "== caddy"
cat > /etc/caddy/Caddyfile <<'EOF'
# Managed by deploy/setup-server.sh. One file per app in /etc/caddy/apps/, written by app-deploy.
import /etc/caddy/apps/*.caddy
EOF
systemctl enable --now caddy >/dev/null
systemctl reload caddy

echo "== tailscale (deploys arrive as tag:ci over Tailscale SSH)"
if ! tailscale status >/dev/null 2>&1; then
  echo "   Log in with the URL below. tag:server must exist in your tailnet policy (see deploy/README.md)."
  tailscale up --ssh --hostname=apps --advertise-tags=tag:server
else
  tailscale set --ssh --hostname=apps
fi

echo "== firewall: web open, SSH via tailscale (public SSH kept as a fallback)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw --force enable >/dev/null

IP=$(curl -fsS4 https://ifconfig.me || echo '<this server IPv4>')
echo
echo "Done. At your DNS provider add:   *.$DOMAIN  A  $IP"
echo "Apps then appear at https://<name>.$DOMAIN after their first deploy."
