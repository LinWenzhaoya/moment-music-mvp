#!/usr/bin/env bash
# Mirror the local music library (MUSIC_LIBRARY_PATH) to OSS under 曲库/. Safe to re-run: files already
# uploaded and unchanged are skipped, so an interrupted upload simply continues.
set -euo pipefail
cd "$(dirname "$0")/.."
env_value() { grep -E "^$1=" .env.local | tail -1 | cut -d= -f2-; }
export OSS_ACCESS_KEY_ID="$(env_value OSS_ACCESS_KEY_ID)" OSS_ACCESS_KEY_SECRET="$(env_value OSS_ACCESS_KEY_SECRET)"
BUCKET="$(env_value OSS_BUCKET)"; REGION="$(env_value OSS_REGION)"; REGION="${REGION#oss-}"
LIBRARY="$(env_value MUSIC_LIBRARY_PATH)"
ossutil cp -r -u -f -j "${JOBS:-8}" --checkpoint-dir "$HOME/.ossutil-checkpoint" \
  --region "$REGION" -e "oss-$REGION.aliyuncs.com" "$LIBRARY/" "oss://$BUCKET/曲库/"
