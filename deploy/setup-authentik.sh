#!/usr/bin/env bash
# authentik at https://auth.<domain>: identity provider for the apps on this server, with our own login page
# (github.com/cchesk/loginpage) for its "login" flow. Runs in Docker (deploy/authentik/docker-compose.yml) from
# /opt/authentik; configured declaratively by deploy/authentik/blueprints/. Runs next to Authelia until "cutover".
#   sudo bash ~ops/infra/deploy/setup-authentik.sh [OWNER_EMAIL]  install or update (the email is needed the first time)
#   sudo bash ~ops/infra/deploy/setup-authentik.sh google         set Google's OAuth client ID and secret (prompts)
#   sudo bash ~ops/infra/deploy/setup-authentik.sh github         set GitHub's OAuth client ID and secret (prompts)
#   sudo bash ~ops/infra/deploy/setup-authentik.sh lock           remove the owner's bootstrap password (passkey only)
#   sudo bash ~ops/infra/deploy/setup-authentik.sh cutover        secrets.<domain>: switch from Authelia to authentik
#   sudo bash ~ops/infra/deploy/setup-authentik.sh rollback       secrets.<domain>: back to Authelia
#   sudo bash ~ops/infra/deploy/setup-authentik.sh status
# Needs the loginpage repo in ~ops/loginpage (or LOGINPAGE=<dir>). Safe to re-run. See deploy/README.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
DOMAIN=$(cat /etc/apps/domain)
AUTH_HOST=auth.$DOMAIN
DIR=/opt/authentik
ENV=$DIR/.env
LOGINPAGE=${LOGINPAGE:-/home/ops/loginpage}
OWNER=${INFRA_OWNER:-owner}
[[ $OWNER =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || { echo "bad owner name '$OWNER'"; exit 1; }
compose() { docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" "$@"; }

# Sets KEY='value' in .env (values are single-quoted so Docker Compose doesn't expand "$").
set_env() {
  local key=$1 value=$2
  [[ $value != *"'"* && $value != *$'\n'* ]] || { echo "value for $key can't contain quotes or newlines"; exit 1; }
  touch "$ENV"; chmod 600 "$ENV"
  grep -v "^$key=" "$ENV" > "$ENV.tmp" || true
  printf "%s='%s'\n" "$key" "$value" >> "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"
}
get_env() { sed -n "s/^$1='\(.*\)'$/\1/p" "$ENV" 2>/dev/null | tail -1; }

wait_ready() {
  echo -n "   waiting for authentik"
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null http://127.0.0.1:9000/-/health/ready/ 2>/dev/null; then echo " ready"; return 0; fi
    echo -n "."; sleep 2
  done
  echo; echo "authentik didn't become ready; logs:  sudo journalctl -t authentik-server -t authentik-worker -n 50"; exit 1
}

set_source() {
  local slug=$1 name=$2 prefix id secret
  prefix=$(tr '[:lower:]' '[:upper:]' <<<"$slug")
  [ -f "$ENV" ] || { echo "install authentik first: sudo bash $0 <owner-email>"; exit 1; }
  echo "$name sign-in. Redirect / callback URL to register at $name:  https://$AUTH_HOST/source/oauth/callback/$slug/"
  read -rp "  $name client ID: " id
  read -rsp "  $name client secret (not shown): " secret; echo
  [ -n "$id" ] && [ -n "$secret" ] || { echo "both are needed; nothing changed"; exit 1; }
  set_env "${prefix}_CLIENT_ID" "$id"
  set_env "${prefix}_CLIENT_SECRET" "$secret"
  # The worker applies the blueprint on start, which enables the source now that it has credentials.
  compose up -d --force-recreate worker >/dev/null
  echo "Saved. $name sign-in switches on in a minute (blueprint re-apply). Then connect your $name account once:"
  echo "  https://$AUTH_HOST/if/user/#/settings  ->  Connected services  ->  $name"
}

backend_switch() {
  echo "$1" > /etc/apps/auth-backend
  bash "$HERE/setup-secrets.sh"
}

case ${1:-} in
  google) set_source google Google; exit ;;
  github) set_source github GitHub; exit ;;
  lock)
    compose exec -T worker ak shell -c "
from authentik.core.models import User
u = User.objects.get(username='$OWNER')
u.set_unusable_password(); u.save()
print('Password removed for', u.username)"
    echo "Sign in with your passkey (or a connected Google/GitHub account) from now on."; exit ;;
  cutover)
    curl -fsS -o /dev/null "http://127.0.0.1:9000/-/health/ready/" || { echo "authentik isn't running; install it first"; exit 1; }
    backend_switch authentik
    echo "secrets.$DOMAIN now signs in through https://$AUTH_HOST (Authelia is stopped; 'rollback' brings it back)."; exit ;;
  rollback)
    backend_switch authelia
    echo "secrets.$DOMAIN signs in through Authelia again."; exit ;;
  status)
    echo "backend for secrets.$DOMAIN: $(cat /etc/apps/auth-backend 2>/dev/null || echo authelia)"
    compose ps; exit ;;
esac

OWNER_EMAIL=${1:-$(get_env INFRA_OWNER_EMAIL)}
[[ $OWNER_EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "usage (first time): sudo bash $0 <owner-email>"; exit 1; }
[ -f "$LOGINPAGE/install.sh" ] || { echo "login page not found in $LOGINPAGE; first run:  sudo -iu ops gh repo clone cchesk/loginpage ~/loginpage"; exit 1; }

echo "== docker (Ubuntu packages, updated with the system)"
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
systemctl enable --now docker >/dev/null

echo "== /opt/authentik"
install -d -m 755 "$DIR" "$DIR/blueprints"
# The authentik containers run as uid 1000.
install -d -m 750 -o 1000 -g 1000 "$DIR/data" "$DIR/certs" "$DIR/custom-templates"
install -m 644 "$HERE/authentik/docker-compose.yml" "$DIR/docker-compose.yml"
install -m 644 "$HERE"/authentik/blueprints/*.yaml "$DIR/blueprints/"
FIRST_PW=""
[ -n "$(get_env PG_PASS)" ] || set_env PG_PASS "$(openssl rand -hex 32)"
[ -n "$(get_env AUTHENTIK_SECRET_KEY)" ] || set_env AUTHENTIK_SECRET_KEY "$(openssl rand -hex 48)"
# akadmin, the built-in admin: a random password nobody needs (break-glass only: it's in this file).
[ -n "$(get_env AUTHENTIK_BOOTSTRAP_PASSWORD)" ] || set_env AUTHENTIK_BOOTSTRAP_PASSWORD "$(openssl rand -hex 24)"
set_env AUTHENTIK_BOOTSTRAP_EMAIL "akadmin@$DOMAIN"
set_env AUTHENTIK_ERROR_REPORTING__ENABLED false
set_env AUTHENTIK_DISABLE_STARTUP_ANALYTICS true
set_env INFRA_DOMAIN "$DOMAIN"
set_env INFRA_OWNER "$OWNER"
set_env INFRA_OWNER_EMAIL "$OWNER_EMAIL"
if [ -z "$(get_env INFRA_OWNER_PASSWORD)" ]; then
  FIRST_PW=$(openssl rand -hex 16)
  set_env INFRA_OWNER_PASSWORD "$FIRST_PW"
fi

cat > /etc/systemd/system/authentik.service <<EOF
# Managed by deploy/setup-authentik.sh
[Unit]
Description=authentik (docker compose in $DIR)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$DIR
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecReload=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable authentik >/dev/null 2>&1
echo "   pulling images and starting (the first time takes a few minutes)"
compose pull -q
compose up -d --remove-orphans
wait_ready

echo "== login page for $AUTH_HOST (from $LOGINPAGE)"
bash "$LOGINPAGE/install.sh" /opt/loginpage-authentik >/dev/null
cat > /opt/loginpage-authentik/config.json <<EOF
{
  "brand": { "name": "", "logo": "assets/logo.svg", "tagline": "", "footer": "" },
  "backend": { "type": "authentik", "flow": "login", "invalidationFlow": "default-invalidation-flow" },
  "defaultRedirect": "https://secrets.$DOMAIN/",
  "passkey": true,
  "password": true,
  "remember": false,
  "providers": ["google", "github"],
  "signup": false
}
EOF

echo "== caddy site $AUTH_HOST"
mkdir -p /etc/caddy/sites
grep -q '^import /etc/caddy/sites/' /etc/caddy/Caddyfile || echo 'import /etc/caddy/sites/*.caddy' >> /etc/caddy/Caddyfile
cat > /etc/caddy/sites/auth.caddy <<EOF
# Managed by deploy/setup-authentik.sh (not in apps/, so app-deploy can never overwrite it)
$AUTH_HOST {
	# authentik's "login" flow is shown by our login page; ?native=1 is the way back to authentik's own UI for steps
	# our page can't render.
	@loginflow {
		path /if/flow/login /if/flow/login/*
		not query native=1
	}
	redir @loginflow /login/?{query} 302
	redir /login /login/
	@login path /login/*
	handle @login {
		uri strip_prefix /login
		root * /opt/loginpage-authentik
		file_server
		header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
		header Cache-Control "no-cache"
	}
	# Everything else is authentik: its API (used by the login page), admin and user settings, OAuth callbacks.
	handle {
		reverse_proxy 127.0.0.1:9000
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy same-origin
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile; exit 1; }
systemctl reload caddy

echo
echo "Done: https://$AUTH_HOST  (secrets.$DOMAIN still uses $(cat /etc/apps/auth-backend 2>/dev/null || echo authelia))"
if [ -n "$FIRST_PW" ]; then
  cat <<EOF

First steps (once):
  1. Sign in at https://$AUTH_HOST as '$OWNER' with this one-time password:  $FIRST_PW
  2. Add a passkey: https://$AUTH_HOST/if/user/#/settings -> MFA Devices -> Enroll -> WebAuthn (Touch ID / Face ID).
     Add a second one on another device too.
  3. Sign out, sign in again with "Sign in with a passkey", then:  sudo bash $0 cutover
  4. When the passkey works everywhere:  sudo bash $0 lock
Google / GitHub sign-in:  sudo bash $0 google   and   sudo bash $0 github   (see deploy/README.md)
EOF
fi
