"""AIS Meteo/Hydro Collector — production rewrite."""

import logging
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import db
import poller
from routes.api import router as api_router
from routes.pages import router as pages_router
from middleware import AuthRateLimitMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

STATIC_DIR = Path(__file__).resolve().parent / "static"

logger = logging.getLogger(__name__)
logger.info("Static dir: %s (exists=%s)", STATIC_DIR, STATIC_DIR.exists())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await db.get_pool()
    await poller.start()
    yield
    await poller.stop()
    await db.close_pool()


app = FastAPI(title="AIS Meteo/Hydro Collector", lifespan=lifespan)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])
app.add_middleware(AuthRateLimitMiddleware)

# Static files FIRST so /static/* is matched before routers
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.include_router(api_router)
app.include_router(pages_router)
