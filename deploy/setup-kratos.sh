#!/usr/bin/env bash
# Ory Kratos at https://auth.<domain>: sign-in for the apps on this server (passkey, password, Google, GitHub), with
# our own login page (github.com/cchesk/loginpage) and a small auth gateway (deploy/auth-gateway) that Caddy asks before
# serving an app. No Docker: one Kratos binary with SQLite, plus Node for the gateway. Runs next to Authelia until
# "cutover".
#   sudo bash ~ops/infra/deploy/setup-kratos.sh [OWNER_EMAIL]  install or update (the email is needed the first time)
#   sudo bash ~ops/infra/deploy/setup-kratos.sh google         set Google's OAuth client ID and secret (prompts)
#   sudo bash ~ops/infra/deploy/setup-kratos.sh github         set GitHub's OAuth client ID and secret (prompts)
#   sudo bash ~ops/infra/deploy/setup-kratos.sh lock           remove the owner's password (passkey / Google / GitHub only)
#   sudo bash ~ops/infra/deploy/setup-kratos.sh cutover        secrets.<domain>: switch from Authelia to Kratos
#   sudo bash ~ops/infra/deploy/setup-kratos.sh rollback       secrets.<domain>: back to Authelia
#   sudo bash ~ops/infra/deploy/setup-kratos.sh status
# Needs the loginpage repo in ~ops/loginpage (or LOGINPAGE=<dir>). Safe to re-run. See deploy/README.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
DOMAIN=$(cat /etc/apps/domain)
AUTH_HOST=auth.$DOMAIN
APP_HOST=secrets.$DOMAIN
LOGINPAGE=${LOGINPAGE:-/home/ops/loginpage}
OWNER=${INFRA_OWNER:-owner}
[[ $OWNER =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || { echo "bad owner name '$OWNER'"; exit 1; }
KRATOS_VERSION=26.2.0
KRATOS_SHA256=c80113f2c861b2fbd80290697d1380000111e297716018617423cca7f2e7e668 # kratos_26.2.0-linux_sqlite_64bit.tar.gz
ETC=/etc/kratos
ADMIN_SOCK=/run/kratos/admin.sock

admin() { curl -fsS --unix-socket "$ADMIN_SOCK" -H 'Content-Type: application/json' "$@"; }
owner_id() { admin "http://localhost/admin/identities?credentials_identifier=$OWNER" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["id"] if d else "")'; }

# KEY='value' lines in a root-only file.
set_kv() {
  local file=$1 key=$2 value=$3
  [[ $value != *"'"* && $value != *'"'* && $value != *'\'* && $value != *$'\n'* ]] || { echo "value for $key can't contain quotes, backslashes or newlines"; exit 1; }
  touch "$file"; chmod 600 "$file"
  { grep -v "^$key=" "$file" || true; printf "%s='%s'\n" "$key" "$value"; } > "$file.tmp"
  mv "$file.tmp" "$file"; chmod 600 "$file"
}
get_kv() { sed -n "s/^$2='\(.*\)'$/\1/p" "$1" 2>/dev/null | tail -1; }

# Renders /etc/kratos/kratos.yml from the template, with secrets and the configured Google/GitHub providers.
render_config() {
  local providers=() p id secret scope
  for p in google github; do
    id=$(get_kv "$ETC/oidc.env" "${p^^}_CLIENT_ID"); secret=$(get_kv "$ETC/oidc.env" "${p^^}_CLIENT_SECRET")
    [ -n "$id" ] && [ -n "$secret" ] || continue
    [ "$p" = google ] && scope='["openid","email","profile"]' || scope='["user:email"]'
    providers+=("{\"id\":\"$p\",\"provider\":\"$p\",\"client_id\":\"$id\",\"client_secret\":\"$secret\",\"mapper_url\":\"file://$ETC/oidc.jsonnet\",\"scope\":$scope}")
  done
  local IFS=,
  AUTH_HOST=$AUTH_HOST DEFAULT_APP_HOST=$APP_HOST OIDC_PROVIDERS="[${providers[*]}]" \
  COOKIE_SECRET=$(get_kv "$ETC/secrets.env" COOKIE_SECRET) CIPHER_SECRET=$(get_kv "$ETC/secrets.env" CIPHER_SECRET) \
    envsubst '${AUTH_HOST} ${DEFAULT_APP_HOST} ${COOKIE_SECRET} ${CIPHER_SECRET} ${OIDC_PROVIDERS}' \
    < "$HERE/kratos/kratos.yml" > "$ETC/kratos.yml.tmp"
  chown root:kratos "$ETC/kratos.yml.tmp"; chmod 640 "$ETC/kratos.yml.tmp"
  mv "$ETC/kratos.yml.tmp" "$ETC/kratos.yml"
}

wait_ready() {
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null http://127.0.0.1:4433/health/ready 2>/dev/null && [ -S "$ADMIN_SOCK" ] \
      && curl -fsS -o /dev/null --unix-socket "$ADMIN_SOCK" http://localhost/admin/health/ready 2>/dev/null && return 0
    sleep 1
  done
  journalctl -u kratos -n 30 --no-pager; exit 1
}

# Asks the provider's token endpoint to exchange a made-up code with the credentials. The error tells whether the
# client ID and secret are accepted: "bad code" means yes, "bad client" means no (it can't sign anyone in either way).
# Returns 0 accepted, 1 rejected (and prints why), 2 couldn't tell (offline, unexpected answer).
check_credentials() {
  local slug=$1 id=$2 secret=$3 answer verdict
  if [ "$slug" = google ]; then
    answer=$(curl -sS -m 20 https://oauth2.googleapis.com/token --data-urlencode "client_id=$id" --data-urlencode "client_secret=$secret" \
      -d code=invalid -d "redirect_uri=https://$AUTH_HOST/kratos/self-service/methods/oidc/callback/google" -d grant_type=authorization_code 2>/dev/null) || return 2
  else
    answer=$(curl -sS -m 20 -H 'Accept: application/json' https://github.com/login/oauth/access_token \
      --data-urlencode "client_id=$id" --data-urlencode "client_secret=$secret" -d code=invalid 2>/dev/null) || return 2
  fi
  verdict=$(printf '%s' "$answer" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unknown"); sys.exit()
e = d.get("error", "")
print("ok" if e in ("invalid_grant", "bad_verification_code") else
      "bad:" + (d.get("error_description") or e or "rejected") if e in ("invalid_client", "incorrect_client_credentials", "Not Found") else "unknown")')
  case $verdict in
    ok) return 0 ;;
    bad:*) echo "  ${verdict#bad:}"; return 1 ;;
    *) return 2 ;;
  esac
}

set_source() {
  local slug=$1 name=$2 id secret
  [ -f "$ETC/kratos.yml" ] || { echo "install Kratos first: sudo bash $0 <owner-email>"; exit 1; }
  echo "$name sign-in. Callback / redirect URL to register at $name:"
  echo "  https://$AUTH_HOST/kratos/self-service/methods/oidc/callback/$slug"
  read -rp "  $name client ID: " id
  read -rsp "  $name client secret (not shown): " secret; echo
  id=$(printf '%s' "$id" | tr -d '[:space:]'); secret=$(printf '%s' "$secret" | tr -d '[:space:]')
  [ -n "$id" ] && [ -n "$secret" ] || { echo "both are needed; nothing changed"; exit 1; }
  if [ "$slug" = google ]; then
    [[ $id == *.apps.googleusercontent.com ]] || echo "  note: a Google client ID normally ends in .apps.googleusercontent.com (did the ID and secret get swapped?)"
    [[ $secret == GOCSPX-* ]] && true || echo "  note: a Google client secret normally starts with GOCSPX-"
  fi
  echo "  checking the credentials with $name..."
  rc=0; check_credentials "$slug" "$id" "$secret" || rc=$?
  case $rc in
    0) echo "  $name accepts them." ;;
    1) echo "  $name rejected this client ID / secret, so nothing was saved. Copy them again from $name (for Google: Credentials -> your OAuth client -> add a new secret, and copy it right away)."; exit 1 ;;
    *) echo "  couldn't verify them (no answer from $name); saving anyway." ;;
  esac
  set_kv "$ETC/oidc.env" "${slug^^}_CLIENT_ID" "$id"
  set_kv "$ETC/oidc.env" "${slug^^}_CLIENT_SECRET" "$secret"
  render_config
  systemctl restart kratos; wait_ready
  echo "Saved; the $name button is live. Connect your $name account once: https://$AUTH_HOST/login/?view=account"
}

backend_switch() {
  echo "$1" > /etc/apps/auth-backend
  bash "$HERE/setup-secrets.sh"
}

case ${1:-} in
  google) set_source google Google; exit ;;
  github) set_source github GitHub; exit ;;
  lock)
    id=$(owner_id); [ -n "$id" ] || { echo "no user '$OWNER'"; exit 1; }
    admin -o /dev/null -X DELETE "http://localhost/admin/identities/$id/credentials/password"
    echo "Password removed for '$OWNER'. Sign in with your passkey (or a connected Google/GitHub account)."; exit ;;
  cutover)
    curl -fsS -o /dev/null http://127.0.0.1:4433/health/ready || { echo "Kratos isn't running; install it first"; exit 1; }
    backend_switch kratos
    echo "secrets.$DOMAIN now signs in through https://$AUTH_HOST (Authelia is stopped; 'rollback' brings it back)."; exit ;;
  rollback)
    backend_switch authelia
    echo "secrets.$DOMAIN signs in through Authelia again."; exit ;;
  status)
    echo "backend for secrets.$DOMAIN: $(cat /etc/apps/auth-backend 2>/dev/null || echo authelia)"
    systemctl --no-pager --lines=0 status kratos auth-gateway | grep -E '●|Active|Memory'; exit ;;
esac

OWNER_EMAIL=${1:-$(get_kv "$ETC/secrets.env" OWNER_EMAIL)}
[[ $OWNER_EMAIL =~ ^[^@[:space:]\'\"]+@[^@[:space:]\'\"]+\.[^@[:space:]\'\"]+$ ]] || { echo "usage (first time): sudo bash $0 <owner-email>"; exit 1; }
[ -f "$LOGINPAGE/install.sh" ] || { echo "login page not found in $LOGINPAGE; first run:  sudo -iu ops gh repo clone cchesk/loginpage ~/loginpage"; exit 1; }

echo "== kratos $KRATOS_VERSION (checksum-pinned)"
for u in kratos auth-gateway; do id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$u"; done
# Only these two may open the admin socket: Kratos (which creates it) and the gateway.
getent group kratos-admin >/dev/null || groupadd --system kratos-admin
usermod -aG kratos-admin kratos; usermod -aG kratos-admin auth-gateway
if [ "$(/usr/local/bin/kratos version 2>/dev/null | sed -n 's/^Version:\s*v//p')" != "$KRATOS_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/kratos.tgz" "https://github.com/ory/kratos/releases/download/v$KRATOS_VERSION/kratos_$KRATOS_VERSION-linux_sqlite_64bit.tar.gz"
  echo "$KRATOS_SHA256  $tmp/kratos.tgz" | sha256sum -c --quiet || { echo "checksum mismatch: not installing"; rm -rf "$tmp"; exit 1; }
  tar -xzf "$tmp/kratos.tgz" -C "$tmp" kratos
  install -m 755 "$tmp/kratos" /usr/local/bin/kratos
  rm -rf "$tmp"
fi
install -d -m 750 -o root -g kratos "$ETC"
install -d -m 700 -o kratos -g kratos /var/lib/kratos
install -m 644 "$HERE/kratos/identity.schema.json" "$HERE/kratos/oidc.jsonnet" "$ETC/"
[ -n "$(get_kv "$ETC/secrets.env" COOKIE_SECRET)" ] || set_kv "$ETC/secrets.env" COOKIE_SECRET "$(openssl rand -hex 32)"
[ -n "$(get_kv "$ETC/secrets.env" CIPHER_SECRET)" ] || set_kv "$ETC/secrets.env" CIPHER_SECRET "$(openssl rand -hex 16)"
set_kv "$ETC/secrets.env" OWNER_EMAIL "$OWNER_EMAIL"
touch "$ETC/oidc.env"; chmod 600 "$ETC/oidc.env"
render_config

cat > /etc/systemd/system/kratos.service <<EOF
# Managed by deploy/setup-kratos.sh
[Unit]
Description=Ory Kratos for https://$AUTH_HOST
After=network-online.target
Wants=network-online.target

[Service]
User=kratos
Group=kratos
SupplementaryGroups=kratos-admin
ExecStartPre=/usr/local/bin/kratos migrate sql -e --yes --config $ETC/kratos.yml
ExecStart=/usr/local/bin/kratos serve --config $ETC/kratos.yml
# /run/kratos holds the admin socket. The socket is group kratos-admin, mode 0660 (see kratos.yml), and that is what
# keeps everyone else out; the folder must stay traversable (0755) because its owner and group are kratos, and the
# gateway (group kratos-admin) is neither.
RuntimeDirectory=kratos
RuntimeDirectoryMode=0755
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/kratos
MemoryMax=300M

[Install]
WantedBy=multi-user.target
EOF

echo "== auth gateway"
install -d -m 755 /opt/auth-gateway
install -m 644 "$HERE/auth-gateway/server.js" /opt/auth-gateway/server.js
install -d -m 750 -o root -g auth-gateway /etc/auth-gateway
[ -s /etc/auth-gateway/secret ] || (umask 027; openssl rand -hex 32 > /etc/auth-gateway/secret)
chown root:auth-gateway /etc/auth-gateway/secret; chmod 640 /etc/auth-gateway/secret
# Apps the gateway protects, and which groups may use each (identity metadata_public.groups).
cat > /etc/auth-gateway/apps.json <<EOF
{
  "$APP_HOST": { "groups": ["secrets-admins"] }
}
EOF
chown root:auth-gateway /etc/auth-gateway/apps.json; chmod 640 /etc/auth-gateway/apps.json
cat > /etc/systemd/system/auth-gateway.service <<EOF
# Managed by deploy/setup-kratos.sh
[Unit]
Description=Auth gateway (Caddy forward_auth for Kratos sessions)
After=kratos.service
Wants=kratos.service

[Service]
User=auth-gateway
Group=auth-gateway
SupplementaryGroups=kratos-admin
Environment=AUTH_HOST=$AUTH_HOST
ExecStart=$(command -v node) /opt/auth-gateway/server.js
ExecReload=/bin/kill -HUP \$MAINPID
# The socket lives here; Caddy reaches it through the auth-gateway group.
RuntimeDirectory=auth-gateway
RuntimeDirectoryMode=0750
UMask=0007
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
# It only talks to Kratos on 127.0.0.1 and the admin socket.
IPAddressDeny=any
IPAddressAllow=localhost
MemoryMax=150M
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

NEED_CADDY_RESTART=""
id -nG caddy | grep -qw auth-gateway || { usermod -aG auth-gateway caddy; NEED_CADDY_RESTART=1; }
systemctl daemon-reload
systemctl enable kratos auth-gateway >/dev/null 2>&1
systemctl restart kratos
wait_ready
systemctl restart auth-gateway

# The gateway must reach Kratos' admin API through the socket, and nobody else may (apps run as other users).
if ! runuser -u auth-gateway -- curl -fsS -o /dev/null --unix-socket "$ADMIN_SOCK" http://localhost/admin/health/ready; then
  echo "the auth gateway can't reach Kratos' admin socket $ADMIN_SOCK:"; ls -ld /run/kratos "$ADMIN_SOCK"; exit 1
fi
if runuser -u nobody -- curl -fsS -o /dev/null --unix-socket "$ADMIN_SOCK" http://localhost/admin/health/ready 2>/dev/null; then
  echo "SECURITY: an unprivileged user can reach Kratos' admin API through $ADMIN_SOCK"; ls -ld /run/kratos "$ADMIN_SOCK"; exit 1
fi

echo "== people"
FIRST_PW=""
if [ -z "$(owner_id)" ]; then
  FIRST_PW=$(openssl rand -hex 16)
  admin -o /dev/null -X POST http://localhost/admin/identities -d "$(python3 -c '
import json, sys
owner, email, pw = sys.argv[1:4]
print(json.dumps({"schema_id": "person", "traits": {"email": email, "username": owner},
  "metadata_public": {"groups": ["admins", "secrets-admins"]},
  "credentials": {"password": {"config": {"password": pw}}}}))' "$OWNER" "$OWNER_EMAIL" "$FIRST_PW")"
  echo "   created '$OWNER' (groups admins, secrets-admins)"
fi

echo "== login page for $AUTH_HOST (from $LOGINPAGE)"
bash "$LOGINPAGE/install.sh" /opt/loginpage-kratos >/dev/null
cat > /opt/loginpage-kratos/config.json <<EOF
{
  "brand": { "name": "", "logo": "assets/logo.svg", "tagline": "", "footer": "" },
  "backend": { "type": "kratos", "base": "/kratos" },
  "defaultRedirect": "https://$APP_HOST/",
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
# Managed by deploy/setup-kratos.sh (not in apps/, so app-deploy can never overwrite it)
$AUTH_HOST {
	redir /login /login/
	@login path /login/*
	handle @login {
		uri strip_prefix /login
		root * /opt/loginpage-kratos
		file_server
		header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
		header Cache-Control "no-cache"
	}
	# Kratos' public API (the login page talks to it; Google/GitHub return to it). Its admin API is never exposed.
	handle /kratos/* {
		uri strip_prefix /kratos
		reverse_proxy 127.0.0.1:4433
	}
	# Hands a signed-in person over to an app (one-time code, see deploy/auth-gateway).
	handle /gateway/* {
		reverse_proxy unix//run/auth-gateway/http.sock
	}
	handle {
		redir * /login/
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy same-origin
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile; exit 1; }
# Caddy must restart (not reload) once to pick up its new group; every site blips for about a second.
if [ -n "$NEED_CADDY_RESTART" ]; then systemctl restart caddy; else systemctl reload caddy; fi
for s in kratos auth-gateway caddy; do systemctl is-active --quiet "$s" || { journalctl -u "$s" -n 30 --no-pager; exit 1; }; done

echo
echo "Done: https://$AUTH_HOST  (secrets.$DOMAIN still uses $(cat /etc/apps/auth-backend 2>/dev/null || echo authelia))"
if [ -n "$FIRST_PW" ]; then
  cat <<EOF

First steps (once):
  1. Sign in at https://$AUTH_HOST as '$OWNER' with this one-time password:  $FIRST_PW
  2. Add passkeys: https://$AUTH_HOST/login/?view=account -> "Add a passkey on this device" (do it on each device).
  3. Sign out, sign in with "Sign in with a passkey", then:  sudo bash $0 cutover
  4. When passkeys work everywhere:  sudo bash $0 lock
Google / GitHub sign-in:  sudo bash $0 google   and   sudo bash $0 github   (see deploy/README.md)
EOF
fi
