from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter()
STATIC = Path(__file__).resolve().parent.parent / "static"


@router.get("/")
async def index():
    return FileResponse(STATIC / "index.html")
