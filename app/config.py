import os

# Data sources — multiple AIS endpoints
FETCH_URLS = [
    u.strip() for u in os.getenv(
        "FETCH_URLS",
        "https://m3.hpradar.com/api/binmsgs.json,"
        "https://m4.hpradar.com/api/binmsgs.json,"
        "https://aisinfra.hpradar.com/api/binmsgs.json"
    ).split(",") if u.strip()
]

POLL_INTERVAL = float(os.getenv("POLL_INTERVAL", "180"))

DB_HOST = os.getenv("DB_HOST", "100.100.40.89")
DB_PORT = int(os.getenv("DB_PORT", "5432"))
DB_NAME = os.getenv("DB_NAME", "mhdb")
DB_USER = os.getenv("DB_USER", "ais_user")
DB_PASS = os.getenv("DB_PASS", "RTL2838UHIDIR")

API_KEY = os.getenv("API_KEY", "")  # empty = no auth enforced
MAX_QUERY_LIMIT = 5000
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "9000"))
