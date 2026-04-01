from typing import Optional
from datetime import datetime
from pydantic import BaseModel


class MeteoHydroPoint(BaseModel):
    mmsi: int
    dac: Optional[int] = None
    fi: Optional[int] = None
    ts: datetime
    lon: float
    lat: float
    wspeed: Optional[float] = None
    wdir: Optional[int] = None
    waterlevel: Optional[float] = None
    seastate: Optional[int] = None
    country: Optional[str] = None
    signalpower: Optional[float] = None
