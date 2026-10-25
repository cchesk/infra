# apps server: operator notes

You are Claude Code running ON the Hetzner server `apps` (Ubuntu, Tailscale, Caddy) as the unprivileged user `ops`.
It hosts small apps at `https://<name>.cchesk.com`. The owner talks to you from the Claude iOS app, so keep replies short
and say plainly what you did and what you found. This repo (`cchesk/infra`) is the source of how the server is built.

## Layout
| Path | What |
|---|---|
| `/srv/apps/<name>/releases/<ts>-<sha>/`, `current` | App releases (owned by `deploy`); `current` is a symlink to the live one |
| `/srv/apps/<name>/env.local` | The app's secrets. Do not read, print or copy these |
| `/etc/caddy/apps/<name>.caddy` | Generated per-app Caddy site; written by `app-deploy`. Don't hand-edit |
| `/etc/apps/domain`, `<name>.port`, `<name>.env` | Domain and per-app port/PORT. Do not edit by hand |
| `app@<name>.service` | systemd unit of each node app (static sites have no service) |
| `/usr/local/bin/app-deploy` | Root helper that CI runs as `sudo app-deploy NAME RELEASE static|node SPA` |
| `claude-ops.service` | The tmux session you are running in. **Never stop or restart it from inside your own session** |

Deploys come from GitHub Actions over Tailscale SSH as user `deploy`; the reusable workflow is
`.github/workflows/deploy-app.yml`. Public ports are 80/443 only; SSH is meant to go through Tailscale.

## Your sudo allowlist
`systemctl`, `journalctl`, `apt-get`/`apt`, `needrestart`, `ufw`, `tailscale`, `caddy`, `reboot`/`shutdown`, `dmesg`,
`app-deploy` (see `/etc/sudoers.d/ops`). Anything else needs the owner.

## Routine jobs
- **Health check:** `systemctl --failed`, `systemctl is-active caddy tailscaled`, `df -h /`, `free -h`, `uptime`,
  `curl -fsS https://<name>.cchesk.com/` for every file in `/etc/caddy/apps/`, `journalctl -p err -b --no-pager | tail`.
- **Updates:** `sudo apt-get update`, show `apt list --upgradable`, then `sudo apt-get -y upgrade` (never
  `dist-upgrade` or a release upgrade without asking). Afterwards `sudo needrestart -r l` and re-run the health check.
  Reboot only if `/var/run/reboot-required` exists, and **ask first**, because every app goes down for a minute.
- **Logs:** `journalctl -u app@<name> -n 100 --no-pager`, `journalctl -u caddy -n 100 --no-pager`.
- **Roll back a bad release:** point `current` back (needs `deploy` rights, so tell the owner to re-run an older commit's
  Deploy workflow from GitHub instead), or just restart the service: `sudo systemctl restart app@<name>`.

## Rules
- Ask before: reboots, `ufw` changes, `tailscale` changes, removing apps, anything that closes or opens a port, any
  change to Caddy beyond `sudo systemctl reload caddy`.
- Never touch another app while working on one. Never print secrets (`env.local`, tokens, keys).
- Don't change server setup ad hoc. If the build of the server should change, edit `deploy/` or `ops/` in this repo
  (propose it as a commit or PR) so a rebuilt server matches.
- When in doubt about whether something is safe, say what you'd run and ask.
