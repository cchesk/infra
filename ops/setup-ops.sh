#!/usr/bin/env bash
# Lets Claude Code run ON the apps server and be driven from the Claude iOS app (Remote Control).
#   curl -fsSL https://raw.githubusercontent.com/cchesk/infra/main/ops/setup-ops.sh -o setup-ops.sh
#   sudo bash setup-ops.sh
# Creates an unprivileged `ops` user with a short sudo allowlist, installs Claude Code for it, clones this repo to
# ~ops/infra (its CLAUDE.md briefs the agent) and installs a systemd service that keeps `claude remote-control`
# running in tmux. Safe to re-run. The one manual step (logging in) is printed at the end.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0"; exit 1; }

echo "== packages"
apt-get update -qq
apt-get install -y -qq tmux git curl needrestart >/dev/null

echo "== ops user"
id ops >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ops
# Everything an operator needs, nothing more. Widen deliberately if you want to; `apt` and `systemctl` are already powerful.
cat > /etc/sudoers.d/ops <<'EOF'
Cmnd_Alias OPS_SERVICES = /usr/bin/systemctl, /usr/bin/journalctl
Cmnd_Alias OPS_PACKAGES = /usr/bin/apt-get, /usr/bin/apt, /usr/sbin/needrestart
Cmnd_Alias OPS_NETWORK  = /usr/sbin/ufw, /usr/bin/tailscale, /usr/bin/caddy
Cmnd_Alias OPS_POWER    = /usr/sbin/reboot, /usr/sbin/shutdown
Cmnd_Alias OPS_APPS     = /usr/local/bin/app-deploy, /usr/bin/dmesg
ops ALL=(root) NOPASSWD: OPS_SERVICES, OPS_PACKAGES, OPS_NETWORK, OPS_POWER, OPS_APPS
EOF
chmod 440 /etc/sudoers.d/ops
visudo -cf /etc/sudoers.d/ops >/dev/null

echo "== claude code (installed for ops)"
runuser -u ops -- bash -c 'command -v ~/.local/bin/claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash'
grep -q '.local/bin' /home/ops/.profile || echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/ops/.profile
chown ops:ops /home/ops/.profile

echo "== this repo, as the agent's working folder"
if [ -d /home/ops/infra/.git ]; then
  g() { runuser -u ops -- git -C /home/ops/infra "$@"; }
  g fetch -q origin main
  branch=$(g rev-parse --abbrev-ref HEAD)
  if [ "$branch" = main ]; then
    g merge --ff-only -q origin/main || echo "   WARNING: ~/infra could not fast-forward; resolve it by hand"
  else
    # Never discard work the server's Claude (or you) did on a branch.
    echo "   NOTE: ~/infra is on branch '$branch', not main, so it was left alone and may lack newer settings."
    echo "   Review it, then: sudo -iu ops git -C ~/infra switch main && sudo -iu ops git -C ~/infra merge --ff-only origin/main"
  fi
else
  runuser -u ops -- git clone -q https://github.com/cchesk/infra /home/ops/infra
fi

echo "== service: claude remote-control in tmux, restarted on boot"
cat > /etc/systemd/system/claude-ops.service <<'EOF'
[Unit]
Description=Claude Code Remote Control (ops)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=ops
WorkingDirectory=/home/ops/infra
Environment=TERM=xterm-256color
# The loop restarts claude if it ever exits; attach with: sudo -iu ops tmux attach -t claude
# Starts in auto mode (a classifier approves routine actions); if this account/version rejects auto, falls back to default mode.
ExecStart=/usr/bin/tmux new-session -d -s claude -c /home/ops/infra '/bin/bash -lc "while true; do claude remote-control --name apps-server --spawn same-dir --permission-mode auto || claude remote-control --name apps-server --spawn same-dir; sleep 15; done"'
ExecStop=-/usr/bin/tmux kill-session -t claude

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

cat <<'EOF'

Done. One manual step: log in as ops, once.

  sudo -iu ops
  cd ~/infra
  claude            # sign in with your claude.ai account (open the URL it prints), accept the folder trust prompt,
                    # then type /exit
  exit
  sudo systemctl enable --now claude-ops

Then open the Claude app on your phone: a session named "apps-server" should appear under Code.
Check on it with:  sudo systemctl status claude-ops    and    sudo -iu ops tmux attach -t claude   (Ctrl-b d to leave)
EOF
