#!/usr/bin/env bash
# Optional: a web page for app secrets at https://secrets.<domain>, behind a passkey login. Two login backends:
#   authelia   (default) our own login page (github.com/cchesk/loginpage, at /login/) in front of Authelia (/authelia/)
#   authentik  forward auth through authentik at https://auth.<domain> (deploy/setup-authentik.sh, then its "cutover")
# The choice is kept in /etc/apps/auth-backend.
#   sudo bash ~ops/infra/deploy/setup-secrets.sh [USER]   install or update (USER: login name, default "owner")
#   sudo bash ~ops/infra/deploy/setup-secrets.sh code     show the one-time code Authelia "emailed" (passkey setup)
#   sudo bash ~ops/infra/deploy/setup-secrets.sh lock     replace the bootstrap password with an unknown random one
# Secrets land in /etc/apps/secrets/<app>.env (root-only), which app@<app> loads after env.local. Run after
# setup-server.sh, with the loginpage repo cloned to ~ops/loginpage (or set LOGINPAGE=<dir>). Safe to re-run.
# See deploy/README.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
DOMAIN=$(cat /etc/apps/domain)
HOST=secrets.$DOMAIN
CONF=/etc/authelia
LOGINPAGE=${LOGINPAGE:-/home/ops/loginpage}
BACKEND=$(cat /etc/apps/auth-backend 2>/dev/null || echo authelia)
[[ $BACKEND == authelia || $BACKEND == authentik ]] || { echo "bad /etc/apps/auth-backend: '$BACKEND'"; exit 1; }

# New random password for USER in users.yml; prints it.
set_password() {
  local out pw hash
  out=$(authelia crypto hash generate argon2 --random --random.length 32 --random.charset alphanumeric)
  pw=$(sed -n 's/^Random Password: //p' <<<"$out")
  hash=$(sed -n 's/^Digest: //p' <<<"$out")
  [ -n "$pw" ] && [ -n "$hash" ] || { echo "could not generate a password hash"; exit 1; }
  cat > "$CONF/users.yml" <<EOF
# Managed by deploy/setup-secrets.sh
users:
  $1:
    displayname: '$1'
    password: '$hash'
    email: '$1@$DOMAIN'
EOF
  chown root:authelia "$CONF/users.yml"; chmod 640 "$CONF/users.yml"
  echo "$pw"
}

case ${1:-} in
  code)
    f=/var/lib/authelia/notification.txt
    [ -f "$f" ] || { echo "no message yet; ask for the code in the browser first"; exit 1; }
    tail -n 30 "$f"; exit ;;
  lock)
    user=$(sed -nE 's/^  ([a-z0-9_-]+):$/\1/p' "$CONF/users.yml" | head -1)
    set_password "$user" >/dev/null
    # Setup phase over: a passkey alone (one factor) is enough from now on. Re-runs of this script keep it so.
    touch "$CONF/.locked"
    sed -i -e 's/policy: two_factor/policy: one_factor/' -e '/experimental_enable_passkey_upgrade/d' "$CONF/configuration.yml"
    systemctl restart authelia
    echo "Password login for '$user' now uses a random password nobody knows. Sign in with your passkey."; exit ;;
esac
OWNER=${1:-}
# On the first run users.yml doesn't exist yet (and pipefail would end the script silently), hence the || true.
[ -n "$OWNER" ] || OWNER=$(sed -nE 's/^  ([a-z0-9_-]+):$/\1/p' "$CONF/users.yml" 2>/dev/null | head -1 || true)
OWNER=${OWNER:-owner}
[[ $OWNER =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || { echo "bad user name '$OWNER'"; exit 1; }
FIRST_PW=""

if [ "$BACKEND" = authelia ]; then
[ -f "$LOGINPAGE/install.sh" ] || { echo "login page not found in $LOGINPAGE; first run:  sudo -iu ops gh repo clone cchesk/loginpage ~/loginpage"; exit 1; }

echo "== authelia (apt.authelia.com, kept current by unattended-upgrades)"
apt-get install -y -qq curl unattended-upgrades >/dev/null
curl -fsSL https://www.authelia.com/keys/authelia-security.gpg -o /usr/share/keyrings/authelia-security.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/authelia-security.gpg] https://apt.authelia.com stable main" \
  > /etc/apt/sources.list.d/authelia.list
apt-get update -qq
apt-get install -y -qq authelia >/dev/null
cat > /etc/apt/apt.conf.d/52authelia-unattended-upgrades <<'EOF'
// Managed by deploy/setup-secrets.sh: the login portal faces the internet, so take every Authelia release.
Unattended-Upgrade::Origins-Pattern:: "site=apt.authelia.com";
EOF
id authelia >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin authelia

install -d -m 750 -o root -g authelia "$CONF/assets"
install -m 640 -o root -g authelia "$HERE"/secrets-ui/assets/{logo.png,favicon.ico} "$CONF/assets/"
mkdir -p "$CONF/secrets"
chown root:authelia "$CONF" "$CONF/secrets"; chmod 750 "$CONF" "$CONF/secrets"
for s in jwt session storage; do
  # Never regenerate: a new storage key would make the stored passkeys unreadable.
  [ -s "$CONF/secrets/$s" ] || { openssl rand -hex 48 > "$CONF/secrets/$s"; }
  chown root:authelia "$CONF/secrets/$s"; chmod 640 "$CONF/secrets/$s"
done
[ -f "$CONF/users.yml" ] && grep -q "^  $OWNER:$" "$CONF/users.yml" || FIRST_PW=$(set_password "$OWNER")

POLICY=two_factor
UPGRADE="  experimental_enable_passkey_upgrade: true"
if [ -e "$CONF/.locked" ]; then POLICY=one_factor; UPGRADE=""; fi

cat > "$CONF/configuration.yml" <<EOF
# Managed by deploy/setup-secrets.sh. Identity backend for https://$HOST, served at /authelia: our login page (/login/)
# calls its API, and its own portal there is still used for passkey settings. Secret keys are in ./secrets/.
theme: auto
server:
  address: 'tcp://127.0.0.1:9091/authelia'
  # Same logo and favicon as the secrets page (deploy/secrets-ui/assets).
  asset_path: $CONF/assets/
log:
  level: info
authentication_backend:
  password_reset:
    disable: true
  file:
    path: $CONF/users.yml
access_control:
  default_policy: deny
  rules:
    # Until "setup-secrets.sh lock" this is two_factor, because Authelia only offers passkey registration when some
    # rule needs a second factor. Afterwards a passkey login (one factor, user-verified) is enough, and the password
    # is random and unknown, so only the passkey gets in.
    - domain: '$HOST'
      policy: $POLICY
      subject: 'user:$OWNER'
session:
  cookies:
    # The cookie is scoped to this one host, so the other apps on *.$DOMAIN never receive it.
    - domain: '$HOST'
      authelia_url: 'https://$HOST/authelia'
      default_redirection_url: 'https://$HOST/'
      inactivity: 15m
      expiration: 1h
regulation:
  max_retries: 3
  find_time: 10m
  ban_time: 1h
storage:
  local:
    path: /var/lib/authelia/db.sqlite3
notifier:
  # No mail server needed: one-time codes go to this file; read them with "setup-secrets.sh code".
  filesystem:
    filename: /var/lib/authelia/notification.txt
totp:
  disable: true
webauthn:
  display_name: '$HOST'
  enable_passkey_login: true
  # Safari/iOS doesn't tell Authelia that a new credential is discoverable, so it isn't offered for passkey login.
  # With this on, any credential may be used, and the first successful passkey login flags it as a passkey for good.
  # Experimental, so only until "lock" (which removes it); it isn't needed once the credential has been flagged.
$UPGRADE
  selection_criteria:
    discoverability: required
    user_verification: required
EOF
chown root:authelia "$CONF/configuration.yml"; chmod 640 "$CONF/configuration.yml"

# Our own unit; it takes precedence over the package's.
cat > /etc/systemd/system/authelia.service <<EOF
# Managed by deploy/setup-secrets.sh
[Unit]
Description=Authelia login portal for $HOST
After=network-online.target
Wants=network-online.target

[Service]
User=authelia
Group=authelia
Environment=AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET_FILE=$CONF/secrets/jwt
Environment=AUTHELIA_SESSION_SECRET_FILE=$CONF/secrets/session
Environment=AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=$CONF/secrets/storage
ExecStart=$(command -v authelia) --config $CONF/configuration.yml
StateDirectory=authelia
StateDirectoryMode=0700
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
fi # authelia

echo "== secrets UI and its root helper"
id secrets-ui >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin secrets-ui
install -m 755 "$HERE/app-secret" /usr/local/bin/app-secret
install -d -m 755 /opt/secrets-ui /opt/secrets-ui/assets
install -m 644 "$HERE"/secrets-ui/{server.js,app.js,app.css} /opt/secrets-ui/
install -m 644 "$HERE"/secrets-ui/assets/{logo.svg,logo-white.svg,favicon.svg,favicon.ico,apple-touch-icon.png,mask.woff2} /opt/secrets-ui/assets/
install -d -m 700 /etc/apps/secrets
echo "secrets-ui ALL=(root) NOPASSWD: /usr/local/bin/app-secret" > /etc/sudoers.d/secrets-ui
chmod 440 /etc/sudoers.d/secrets-ui
visudo -cf /etc/sudoers.d/secrets-ui >/dev/null

if [ "$BACKEND" = authentik ]; then SIGNOUT_URL=/outpost.goauthentik.io/sign_out; else SIGNOUT_URL='/login/?logout'; fi
cat > /etc/systemd/system/secrets-ui.service <<EOF
# Managed by deploy/setup-secrets.sh
[Unit]
Description=Secrets page for https://$HOST
After=network.target

[Service]
User=secrets-ui
Group=secrets-ui
Environment=OWNER=$OWNER HOST=$HOST SIGNOUT_URL=$SIGNOUT_URL
ExecStart=$(command -v node) /opt/secrets-ui/server.js
# The socket lives here; Caddy reaches it through the secrets-ui group.
RuntimeDirectory=secrets-ui
RuntimeDirectoryMode=0750
UMask=0007
# Unix socket only, no network. (No ProtectSystem: the root helper it calls via sudo must write /etc/apps/secrets.)
IPAddressDeny=any
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

# Node apps load /etc/apps/secrets/<app>.env after env.local, so values from the page win.
mkdir -p /etc/systemd/system/app@.service.d
cat > /etc/systemd/system/app@.service.d/secrets.conf <<'EOF'
# Managed by deploy/setup-secrets.sh
[Service]
EnvironmentFile=-/etc/apps/secrets/%i.env
EOF

if [ "$BACKEND" = authelia ]; then
echo "== login page (from $LOGINPAGE)"
bash "$LOGINPAGE/install.sh" /opt/loginpage >/dev/null
cat > /opt/loginpage/config.json <<EOF
{
  "brand": { "name": "", "logo": "assets/logo.svg", "tagline": "", "footer": "" },
  "backend": { "type": "authelia", "base": "/authelia" },
  "defaultRedirect": "https://$HOST/",
  "passkey": true,
  "password": true,
  "remember": false,
  "providers": ["google", "apple", "github"],
  "signup": true
}
EOF
fi

echo "== caddy site ($BACKEND)"
mkdir -p /etc/caddy/sites
grep -q '^import /etc/caddy/sites/' /etc/caddy/Caddyfile || echo 'import /etc/caddy/sites/*.caddy' >> /etc/caddy/Caddyfile
if [ "$BACKEND" = authentik ]; then
  ROUTES="	# authentik's embedded outpost (in the authentik server on :9000): login callback and sign-out.
	handle /outpost.goauthentik.io/* {
		reverse_proxy 127.0.0.1:9000
	}
	# Everything else needs an authentik session; without one, the outpost sends the visitor to https://auth.$DOMAIN.
	handle {
		forward_auth 127.0.0.1:9000 {
			uri /outpost.goauthentik.io/auth/caddy
			copy_headers X-Authentik-Username>Remote-User X-Authentik-Groups>Remote-Groups X-Authentik-Email>Remote-Email X-Authentik-Name>Remote-Name
		}
"
else
  ROUTES="	# Our login page: static files, loads without a session.
	redir /login /login/
	@login path /login/*
	handle @login {
		uri strip_prefix /login
		root * /opt/loginpage
		file_server
		header Content-Security-Policy \"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'\"
		header Cache-Control \"no-cache\"
	}
	# Authelia: the API the login page calls, and its own portal (passkey settings at /authelia/settings).
	@authelia path /authelia /authelia/*
	handle @authelia {
		reverse_proxy 127.0.0.1:9091
	}
	# Everything else needs a session; without one, Authelia sends the visitor to our login page.
	handle {
		forward_auth 127.0.0.1:9091 {
			uri /authelia/api/authz/forward-auth?authelia_url=https://$HOST/login/
			copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
		}
"
fi
cat > /etc/caddy/sites/secrets.caddy <<EOF
# Managed by deploy/setup-secrets.sh (not in apps/, so app-deploy can never overwrite it)
$HOST {
	# Identity headers come only from the login backend, never from the client.
	request_header -Remote-User
	request_header -Remote-Groups
	request_header -Remote-Email
	request_header -Remote-Name
$ROUTES		reverse_proxy unix//run/secrets-ui/http.sock {
			header_up -Cookie
		}
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		# Not no-referrer: with that, browsers send "Origin: null" on the page's own saves and the origin check fails.
		Referrer-Policy same-origin
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile; exit 1; }
NEED_CADDY_RESTART=""
id -nG caddy | grep -qw secrets-ui || { usermod -aG secrets-ui caddy; NEED_CADDY_RESTART=1; }

systemctl daemon-reload
systemctl enable secrets-ui >/dev/null 2>&1
systemctl restart secrets-ui
if [ "$BACKEND" = authelia ]; then
  systemctl enable authelia >/dev/null 2>&1
  systemctl restart authelia
else
  # Kept installed and configured, so "setup-authentik.sh rollback" can bring it back.
  systemctl disable --now authelia >/dev/null 2>&1 || true
fi
# Caddy must restart (not reload) once to pick up its new group; every site blips for about a second.
if [ -n "$NEED_CADDY_RESTART" ]; then systemctl restart caddy; else systemctl reload caddy; fi
sleep 2
for s in secrets-ui caddy $([ "$BACKEND" = authelia ] && echo authelia); do
  systemctl is-active --quiet "$s" || { journalctl -u "$s" -n 30 --no-pager; exit 1; }
done

echo
echo "Done: https://$HOST"
if [ -n "$FIRST_PW" ]; then
  cat <<EOF

First sign-in (once):
  (Use Authelia's own portal at /authelia/ for these steps; it handles the two-step sign-in of the setup phase.)
  1. Open https://$HOST/authelia/ and sign in as '$OWNER' with this one-time password:  $FIRST_PW
  2. Open https://$HOST/authelia/settings -> Two-Factor Authentication -> add a security key / passkey (Touch ID / Face ID).
     When it asks for a one-time code:  sudo bash $0 code
     Add a second passkey too (another device or a security key) so you can't lock yourself out.
  3. Sign out and use "Sign in with a passkey" on /authelia/. For now it still asks for the password after the
     passkey (that is the two-factor rule, and this first passkey login is what flags the credential as a passkey).
     Do this on every device you registered, then:  sudo bash $0 lock
     After that, the passkey alone is enough, and https://$HOST/login/ is the sign-in page.
EOF
fi
