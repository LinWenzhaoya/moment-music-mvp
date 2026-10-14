#!/usr/bin/env bash
# Build the static frontend and ship code to the server. Never touches the server's database or .env.local.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${DEPLOY_HOST:-$(grep -E "^DEPLOY_HOST=" .env.local | cut -d= -f2-)}"
[ -n "$HOST" ] || { echo "Set DEPLOY_HOST=admin@<server-ip> in .env.local"; exit 1; }
SSH="ssh -i $HOME/.ssh/moment_aliyun_rsa"
node deploy/build-static.mjs
rsync -az --delete -e "$SSH" \
  --include='package.json' --include='package-lock.json' \
  --include='local-music/' --include='local-music/*.mjs' --include='local-music/*.json' --include='local-music/*.html' \
  --include='scripts/' --include='scripts/*.mjs' --include='scripts/*.json' \
  --include='deploy/***' --include='dist/' --include='dist/static/***' \
  --exclude='*' ./ "$HOST:/srv/moment/app/"
$SSH "$HOST" 'cd /srv/moment/app && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error && sudo systemctl restart moment-api && (sudo systemctl reload caddy 2>/dev/null || true) && echo deployed'
