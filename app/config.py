import os

# Data sources with per-source poll intervals (seconds)
# Format: url|interval,url|interval,...
# If no |interval, uses DEFAULT_POLL_INTERVAL
_raw = os.getenv(
    "FETCH_SOURCES",
    "https://m3.hpradar.com/api/binmsgs.json|60,"
    "https://m4.hpradar.com/api/binmsgs.json|60,"
    "https://aisinfra.hpradar.com/api/binmsgs.json|90"
)
DEFAULT_POLL_INTERVAL = float(os.getenv("POLL_INTERVAL", "120"))

SOURCES = []
for entry in _raw.split(","):
    entry = entry.strip()
    if not entry:
        continue
    if "|" in entry:
        url, iv = entry.rsplit("|", 1)
        SOURCES.append({"url": url.strip(), "interval": float(iv)})
    else:
        SOURCES.append({"url": entry, "interval": DEFAULT_POLL_INTERVAL})

# Keep flat URL list for backward compat
FETCH_URLS = [s["url"] for s in SOURCES]

DB_HOST = os.getenv("DB_HOST", "100.100.40.89")
DB_PORT = int(os.getenv("DB_PORT", "5432"))
DB_NAME = os.getenv("DB_NAME", "mhdb")
DB_USER = os.getenv("DB_USER", "ais_user")
DB_PASS = os.getenv("DB_PASS", "RTL2838UHIDIR")

API_KEY = os.getenv("API_KEY", "")
MAX_QUERY_LIMIT = 5000
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "9000"))
