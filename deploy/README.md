# Apps server: push to deploy, one subdomain per app

This sets up one server (a Hetzner box) that hosts any number of apps at `https://<name>.<your-domain>`. Each repo
deploys itself on every push to `main`, including pushes Claude makes from the iOS app.

```
git push ─► GitHub Actions ─► build ─► join tailnet (tag:ci) ─► rsync over Tailscale SSH ─► sudo app-deploy
                                                                                  │
          internet ─► Caddy :443 (automatic HTTPS) ─► static files  or  app@<name> systemd service on $PORT
```

- `.github/workflows/deploy-app.yml` is the reusable workflow that every repo calls.
- `deploy/app-deploy` is the root helper on the server. It switches to the new release atomically, writes the Caddy
  site, assigns a port, runs `npm ci --omit=dev` and restarts the service. It keeps 5 releases.
- `deploy/setup-server.sh` is the one-time server setup: Node 22, Caddy, Tailscale, the `deploy` user and ufw.

SSH is reachable only through Tailscale. The internet sees ports 80 and 443 only, plus public SSH as a fallback until
you close it.

## One-time setup

**1. Domain.** At your registrar or DNS provider, add an `A` record for `*` (that is, `*.yourdomain.com`) pointing at
the server's public IPv4. For IPv6, also add an `AAAA` record.

**2. Tailscale admin console**
- Access controls: add the following to the policy file and keep your existing rules.
  ```jsonc
  "tagOwners": {
    "tag:server": ["autogroup:admin"],
    "tag:ci":     ["autogroup:admin"]
  },
  // Only needed if you replaced the default allow-all rule:
  "grants": [{ "src": ["tag:ci"], "dst": ["tag:server"], "ip": ["22"] }],
  "ssh": [
    // keep your existing entries, add:
    { "action": "accept", "src": ["tag:ci"], "dst": ["tag:server"], "users": ["deploy"] }
  ]
  ```
- Settings → OAuth clients → **Generate**: give it the scope *Auth Keys: write* and the tag `tag:ci`. Keep the client
  ID and secret.

**3. Server** (SSH in as root)
```bash
curl -fsSL https://raw.githubusercontent.com/cchesk/infra/main/deploy/setup-server.sh -o setup.sh
sudo bash setup.sh yourdomain.com
```
Open the Tailscale login link it prints. The machine joins your tailnet as `apps`.

**4. Each repo that deploys:** Settings → Secrets and variables → Actions → add the secrets `TS_OAUTH_CLIENT_ID` and
`TS_OAUTH_SECRET`. Use the same values for every repo. A repo without them skips the deploy with a warning.

## Adding a new project

Add `.github/workflows/deploy.yml` to the repo and add the two secrets. The first push creates
`https://<name>.yourdomain.com`.

Static site (Vite, React, plain HTML):
```yaml
name: Deploy
on: { push: { branches: [main] }, workflow_dispatch: {} }
jobs:
  deploy:
    uses: cchesk/infra/.github/workflows/deploy-app.yml@main
    with:
      name: myapp
      type: static
      build: npm ci && npm test && npm run build
      dir: dist
      spa: true            # client-side routing: unknown paths serve index.html
    secrets:
      TS_OAUTH_CLIENT_ID: ${{ secrets.TS_OAUTH_CLIENT_ID }}
      TS_OAUTH_SECRET: ${{ secrets.TS_OAUTH_SECRET }}
```

Node service (an API or a server-rendered app). It must listen on `process.env.PORT`:
```yaml
    with:
      name: myapp-api
      type: node
      build: npm ci && npm run build        # optional; the server runs `npm ci --omit=dev` itself
      start: node dist/server.js            # default: npm start
      health_path: /health                  # default: /
```

A site plus its API means two jobs, the site with `needs: api`. `.github/workflows/deploy.yml` in this repo does exactly
that. Build commands can use `$APPS_DOMAIN`, e.g. `VITE_API_URL=https://myapp-api.$APPS_DOMAIN npm run build`.

Other inputs: `host` (Tailscale hostname, default `apps`) and `node_version` (default `22`).

## Running it

| | |
|---|---|
| Secrets for a node app | `/srv/apps/<name>/env.local` on the server, one `KEY=value` per line, then `sudo systemctl restart app@<name>` |
| Logs | `journalctl -u app@<name> -f`, `journalctl -u caddy -f` |
| Roll back | `cd /srv/apps/<name> && ln -sfn releases/<older> current`, then restart the service for node apps |
| Remove an app | `sudo systemctl disable --now app@<name>; sudo rm /etc/caddy/apps/<name>.caddy /etc/apps/<name>.*; sudo systemctl reload caddy; sudo rm -r /srv/apps/<name>` |
| Close public SSH | once Tailscale SSH works: `sudo ufw delete allow OpenSSH` (the Hetzner web console stays as a way in) |

## Optional: tailnet-only web proxy

`deploy/setup-proxy.sh` installs tinyproxy on `http://<tailscale-ip>:8888`, so that a tailnet device (for example a
Claude cloud session) can send its web traffic out through this server. It listens on the Tailscale IP only and
accepts only Tailscale source addresses; no ufw change is needed because ufw already denies everything public except
80/443. It refuses to reach this server's loopback services, the Hetzner metadata address, private ranges and tailnet
host names. HTTPS `CONNECT` is limited to port 443.
```bash
sudo bash ~ops/infra/deploy/setup-proxy.sh
```

Tailscale policy, so a proxy client gets port 8888 on the server and nothing else:
```jsonc
"tagOwners": { "tag:proxy-client": ["autogroup:admin"] },
"grants": [{ "src": ["tag:proxy-client"], "dst": ["tag:server"], "ip": ["tcp:8888"] }]
```
Then create a **reusable, ephemeral, pre-approved** auth key tagged `tag:proxy-client` (Settings → Keys).

A Claude cloud container usually has no TUN device, so tailscaled runs in userspace mode there and the proxy is reached
through tailscaled's own local proxy. In the environment's setup script (auth key in the `TS_AUTHKEY` env var; needs
network access to `*.tailscale.com`):
```bash
curl -fsSL https://tailscale.com/install.sh | sh
apt-get install -y socat
tailscaled --tun=userspace-networking --state=mem: --outbound-http-proxy-listen=127.0.0.1:1055 >/tmp/tailscaled.log 2>&1 &
tailscale up --auth-key="$TS_AUTHKEY" --hostname=claude-cloud
# Local port 8888 -> tailscaled -> apps (its Tailscale IP):8888
socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr PROXY:127.0.0.1:100.104.209.31:8888,proxyport=1055 &
export HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888
```

## Optional: secrets page with passkey login

`deploy/setup-secrets.sh` publishes `https://secrets.<domain>`, a page that lists each node app's secrets (masked,
with show and copy buttons) and lets you edit, add and remove them, then save and restart the app. Anyone who gets
past the login can read every secret, so the login is what protects them.

- **Login:** Authelia (from `apt.authelia.com`, auto-updated by unattended-upgrades) at `/auth`. You sign in with a
  passkey (Touch ID / Face ID or a security key). The bootstrap password is replaced by an unknown random one.
  Failed logins get you banned for an hour after 3 tries. The session cookie belongs to `secrets.<domain>` only, so
  the other apps never see it.
- **Isolation:** the page (`deploy/secrets-ui/`, Node, no dependencies) listens on a unix socket that only Caddy can
  open, and trusts Caddy's `Remote-User` header only. It reads and writes through the root helper
  `/usr/local/bin/app-secret`, its only sudo right, which accepts only an existing node app and touches just
  `/etc/apps/secrets/<app>.env` (root-only, `PORT` refused) and `app@<app>`. `app@<app>` loads that file after
  `env.local`, so a key set on the page wins. Keys that only exist in `env.local` aren't shown on the page.

```bash
sudo bash ~ops/infra/deploy/setup-secrets.sh            # prints a one-time password and the first-login steps
sudo bash ~ops/infra/deploy/setup-secrets.sh code       # one-time code while you add a passkey
sudo bash ~ops/infra/deploy/setup-secrets.sh lock       # afterwards: passkey only
```
Adding another passkey later needs `code` again (as root over SSH). Re-running the script keeps users, passkeys and
keys; `deploy/app-secret` and `deploy/secrets-ui/` are re-installed from this checkout.

Note: other repos run this workflow straight from `cchesk/infra@main`, so changes here affect every app.
