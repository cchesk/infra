# infra

Everything about the apps server (`*.cchesk.com` on Hetzner, reached over Tailscale).

| | |
|---|---|
| [`deploy/`](deploy/README.md) | One-time server setup (Caddy, Node, Tailscale, `deploy` user), the `app-deploy` helper, and how any repo deploys itself with a few lines of workflow |
| [`.github/workflows/deploy-app.yml`](.github/workflows/deploy-app.yml) | The reusable deploy workflow other repos call: `uses: cchesk/infra/.github/workflows/deploy-app.yml@main` |
| [`ops/setup-ops.sh`](ops/setup-ops.sh) | Runs Claude Code on the server as a limited `ops` user, reachable from the Claude iOS app (Remote Control) |
| [`CLAUDE.md`](CLAUDE.md) | Briefing for that on-server Claude: layout, routine jobs, rules |

## Set up in order
1. `deploy/` (see its README): DNS, Tailscale policy and OAuth client, `setup-server.sh`, repo secrets.
2. Ops access from your phone:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/cchesk/infra/main/ops/setup-ops.sh -o setup-ops.sh
   sudo bash setup-ops.sh
   ```
   Then follow the three login steps it prints. The session shows up as `apps-server` in the Claude app.

This repo is public and holds no secrets. Because other repos run its workflow from `main`, a change here affects
every app's next deploy.
