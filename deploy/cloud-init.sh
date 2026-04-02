#!/bin/bash
# cloud-init user-data script
# Paste this into your VPS provider's "User Data" / "Startup Script" field
# Replace the 3 values below before deploying:

DB_PASS="CHANGE_ME"
CF_TUNNEL_TOKEN="CHANGE_ME"
DB_HOST="CHANGE_ME"

# ── Install Docker ──
curl -fsSL https://get.docker.com | sh

# ── Clone & configure ──
git clone https://github.com/ngtrthanh/hpradar-meteo.git /srv/tide
cd /srv/tide

cat > .env << EOF
FETCH_SOURCES=https://m3.hpradar.com/api/binmsgs.json|60,https://m4.hpradar.com/api/binmsgs.json|60,https://aisinfra.hpradar.com/api/binmsgs.json|90
DB_HOST=${DB_HOST}
DB_PORT=5432
DB_NAME=mhdb
DB_USER=ais_user
DB_PASS=${DB_PASS}
CF_TUNNEL_TOKEN=${CF_TUNNEL_TOKEN}
RETENTION_DAYS=9000
EOF

# ── Pull pre-built image & run ──
docker compose pull
docker compose up -d

# ── Auto-update via cron (pull latest image daily at 4am) ──
echo "0 4 * * * cd /srv/tide && docker compose pull && docker compose up -d && docker image prune -f" | crontab -
