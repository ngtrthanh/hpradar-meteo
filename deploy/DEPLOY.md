# Deployment Guide

## Architecture

```
GitHub                          VPS (no source code)
──────                          ────────────────────
push to branch                  docker-compose.yml + .env
  ↓
GitHub Actions
  lint → build → push image
  ↓
GHCR (ghcr.io/ngtrthanh/hpradar-meteo)
  :dev  :staging  :latest
  ↓
Watchtower (on VPS)
  detects new image → pulls → restarts
  ↓
Cloudflare Tunnel
  ↓
Public: tide.hpradar.com
```

## Environments

| Branch | Image Tag | Domain | Watchtower | Port |
|---|---|---|---|---|
| `dev` | `:dev` | test-tide.hpradar.com | 2 min | 8113 |
| `staging` | `:staging` | staging-tide.hpradar.com | 5 min | 8112 |
| `main` | `:latest` | tide.hpradar.com | 5 min | 8111 |

## Promotion Flow

```
dev  →  staging  →  main
 ↓         ↓          ↓
:dev    :staging    :latest
 ↓         ↓          ↓
test    staging     production
```

```bash
# Daily development
git checkout dev && git push

# Promote to staging
git checkout staging && git merge dev && git push

# Promote to production
git checkout main && git merge staging && git push
```

## Initial VPS Setup (one time)

### Prerequisites

- VPS with 1 CPU, 1 GB RAM minimum (Ubuntu 22.04+ / Debian 12+)
- PostgreSQL/TimescaleDB (local or remote)
- Cloudflare tunnel token (one per environment)

### Install

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Create directory
mkdir -p /srv/tide && cd /srv/tide

# Download compose file (pick one)
curl -O https://raw.githubusercontent.com/ngtrthanh/hpradar-meteo/main/deploy/docker-compose.prod.yml
mv docker-compose.prod.yml docker-compose.yml

# For staging:
# curl -O .../deploy/docker-compose.staging.yml && mv ... docker-compose.yml
# For dev:
# curl -O .../deploy/docker-compose.dev.yml && mv ... docker-compose.yml

# Create .env
cat > .env << 'EOF'
DB_HOST=your-db-ip
DB_PORT=5432
DB_NAME=mhdb
DB_USER=ais_user
DB_PASS=your-db-password
CF_TUNNEL_TOKEN=your-cloudflare-tunnel-token
RETENTION_DAYS=9000
EOF

# Start
docker compose up -d
```

### What happens

1. Docker pulls pre-built image from GHCR (no compile)
2. App starts, auto-creates DB tables, begins polling AIS data
3. Cloudflared connects tunnel to your subdomain
4. Watchtower monitors GHCR for new images

### Verify

```bash
docker compose ps                        # all services running
curl -s http://localhost:8111/api/health  # {"status":"ok",...}
docker compose logs -f hydro-api         # watch data flowing
```

## Cloudflare Tunnel Setup

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels
2. Create a tunnel (one per environment)
3. Add public hostname:
   - `tide.hpradar.com` → `http://hydro-api:8000` (production)
   - `staging-tide.hpradar.com` → `http://hydro-api-staging:8000` (staging)
   - `test-tide.hpradar.com` → `http://hydro-api-dev:8000` (dev)
4. Copy the tunnel token → paste into `.env` as `CF_TUNNEL_TOKEN`

WebSocket (`/api/ws/live`) works through CF Tunnel automatically.

## GitHub Setup (one time)

### Enable image publishing

Repo → Settings → Actions → General → Workflow permissions → **Read and write permissions**

### Create branches

```bash
git checkout -b staging && git push -u origin staging
git checkout -b dev && git push -u origin dev
```

## Running Multiple Environments on One VPS

```bash
# Production
mkdir -p /srv/tide && cd /srv/tide
# → docker-compose.prod.yml + .env (prod CF token, port 8111)

# Staging
mkdir -p /srv/tide-staging && cd /srv/tide-staging
# → docker-compose.staging.yml + .env (staging CF token, port 8112)

# Dev
mkdir -p /srv/tide-dev && cd /srv/tide-dev
# → docker-compose.dev.yml + .env (dev CF token, port 8113)
```

Each directory is independent. Different container names prevent conflicts.

## Auto-Update

Watchtower handles everything:

- Checks GHCR on interval (2 min dev, 5 min staging/prod)
- Detects new image digest
- Pulls new image
- Restarts container with same config
- Prunes old images (`--cleanup`)

**No SSH, no cron, no deploy scripts needed after initial setup.**

## Manual Operations

```bash
# Force pull latest image
docker compose pull && docker compose up -d

# View logs
docker compose logs -f hydro-api

# Restart
docker compose restart hydro-api

# Stop everything
docker compose down

# Check health
curl -s http://localhost:8111/api/health | python3 -m json.tool
```

## Cloud-Init (zero-touch VPS creation)

For VPS providers that support user-data scripts (DigitalOcean, Hetzner, Vultr, AWS):

```bash
#!/bin/bash
curl -fsSL https://get.docker.com | sh
mkdir -p /srv/tide && cd /srv/tide
curl -O https://raw.githubusercontent.com/ngtrthanh/hpradar-meteo/main/deploy/docker-compose.prod.yml
mv docker-compose.prod.yml docker-compose.yml
cat > .env << 'EOF'
DB_HOST=your-db-ip
DB_PASS=your-db-password
CF_TUNNEL_TOKEN=your-tunnel-token
EOF
docker compose up -d
```

Paste into the "User Data" field when creating the VPS. It boots and runs — no SSH needed.

## Troubleshooting

| Issue | Fix |
|---|---|
| Container restarting | `docker compose logs hydro-api` — check DB connection |
| Tunnel not connecting | Verify `CF_TUNNEL_TOKEN` in `.env`, check `docker compose logs cloudflared` |
| Watchtower not updating | `docker compose logs watchtower` — check GHCR access |
| Image not found | Verify GitHub Actions ran: repo → Actions tab |
| DB permission errors | Migrations are optional — app works without ALTER TABLE permissions |
