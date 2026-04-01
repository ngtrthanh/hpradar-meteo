"""Middleware for API key auth and rate limiting (Phase 3 items 10-11)."""

import time
from collections import defaultdict

from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware

import config

# Simple token-bucket rate limiter
_buckets: dict[str, list] = defaultdict(list)
RATE_LIMIT = 60          # requests per window
RATE_WINDOW = 60          # seconds
DEBUG_RATE_LIMIT = 1      # 1 req/min for debug endpoints


class AuthRateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Health is always public
        if path == "/api/health":
            return await call_next(request)

        # Static files and pages — no auth needed
        if not path.startswith("/api"):
            return await call_next(request)

        # API key check (only if API_KEY is configured)
        if config.API_KEY:
            auth = request.headers.get("authorization", "")
            key = request.query_params.get("api_key", "")
            if auth != f"Bearer {config.API_KEY}" and key != config.API_KEY:
                raise HTTPException(status_code=401, detail="Invalid or missing API key")

        # Rate limiting
        client_ip = request.client.host if request.client else "unknown"
        now = time.time()
        bucket_key = client_ip

        # Stricter limit for debug endpoints
        if path.startswith("/api/debug"):
            bucket_key = f"debug:{client_ip}"
            limit = DEBUG_RATE_LIMIT
        else:
            limit = RATE_LIMIT

        # Clean old entries and check
        _buckets[bucket_key] = [t for t in _buckets[bucket_key] if now - t < RATE_WINDOW]
        if len(_buckets[bucket_key]) >= limit:
            raise HTTPException(status_code=429, detail="Rate limit exceeded")
        _buckets[bucket_key].append(now)

        return await call_next(request)
