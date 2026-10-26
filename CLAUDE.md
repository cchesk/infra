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

## Occasional tools
- **Create a new GitHub repository** (when the owner says "create a new github repository" or similar): run
  `~/work/githubcli/create_private_repo.sh <repo-name> ["description"]`. It makes a **private** repo under the owner's
  account via `gh repo create`. Ask for the name if not given; never guess it. Run `git -C ~/work/githubcli pull` first
  so the script is current. Needs `gh` installed and authenticated (`gh auth status`); if not, say so and ask the
  owner (don't hunt for tokens). Clone is `cchesk/githubcli`, read-only via deploy key `~/.ssh/githubcli_deploy`.

## How permissions work here
The session runs in `auto` permission mode (flag in `ops/setup-ops.sh`). `.claude/settings.json` adds: read-only commands pre-approved
(`allow`); commands that change the system always prompt the owner, even in auto mode (`ask`: reboot, restarts, upgrades/installs,
ufw, tailscale, `app-deploy`, `rm -r`); and hard blocks (`deny`: reading `env.local`, stopping your own `claude-ops` session).
If you need something blocked, ask the owner; don't look for a way around a rule.

## Rules
- Ask before: reboots, `ufw` changes, `tailscale` changes, removing apps, anything that closes or opens a port, any
  change to Caddy beyond `sudo systemctl reload caddy`.
- Never touch another app while working on one. Never print secrets (`env.local`, tokens, keys).
- Don't change server setup ad hoc. If the build of the server should change, edit `deploy/` or `ops/` in this repo
  (propose it as a commit or PR) so a rebuilt server matches.
- When in doubt about whether something is safe, say what you'd run and ask.
