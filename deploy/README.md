# Cloud deployment

One server runs everything behind Caddy (HTTPS + password): the static frontend, the Node API on
127.0.0.1:3001, and the music library from OSS mounted at `/mnt/oss`. The cloud database is the source
of truth; it is backed up to OSS (`backups/`) every day at 04:30.

Settings live in `.env.local` (never committed): `DEPLOY_HOST`, `OSS_*`. SSH uses `~/.ssh/moment_aliyun_rsa`.

| Task | Command |
|---|---|
| Ship code changes | `./deploy/deploy.sh` |
| Upload new/changed music to OSS | `./deploy/upload-library.sh` |
| Get the cloud database for local work | `node deploy/db-sync.mjs pull` |
| Put it back | `node deploy/db-sync.mjs push` |

## Adding new songs

1. `node deploy/db-sync.mjs pull`
2. Download songs into the local library, start the local server (`npm run music:server`) and rescan.
3. Tag and embed: `node scripts/tag-audio-omni.mjs`, `node scripts/build-embeddings.mjs`.
4. `./deploy/upload-library.sh`
5. Stop the local server, then `node deploy/db-sync.mjs push` (the cloud API pauses for about a minute).

Push refuses if the cloud recorded new activity after the pull; pull again and redo step 2–3.
