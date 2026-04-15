import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from starlette.responses import JSONResponse

from backend.api.routes.admin import router as admin_router
from backend.api.routes.auth import router as auth_router
from backend.api.routes.config import router as config_router
from backend.api.routes.events import router as events_router
from backend.api.routes.settings import router as settings_router
from backend.api.routes.suggestions import router as suggestions_router
from backend.api.routes.tracking import router as tracking_router
from backend.api.schemas import HealthResponse
from backend.config.loader import get_calendar_service_type, get_cors_origins
from backend.db.database import init_db
from backend.services.scheduler import run_sync_loop

logger = logging.getLogger(__name__)

limiter = Limiter(key_func=get_remote_address)


def _create_calendar_service():
    service_type = get_calendar_service_type()
    if service_type == "google":
        from backend.services.calendar.google_calendar import GoogleCalendarService

        return GoogleCalendarService()
    else:
        from backend.services.calendar.mock_calendar import MockCalendarService

        return MockCalendarService()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    calendar_service = _create_calendar_service()
    app.state.calendar_service = calendar_service
    sync_task = asyncio.create_task(run_sync_loop(calendar_service))
    logger.info("Started sync scheduler (service=%s)", type(calendar_service).__name__)
    yield
    sync_task.cancel()
    try:
        await sync_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Salsa Events Calendar", lifespan=lifespan)
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request, exc):
    return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})


app.include_router(auth_router)
app.include_router(events_router)
app.include_router(tracking_router)
app.include_router(admin_router)
app.include_router(settings_router)
app.include_router(config_router)
app.include_router(suggestions_router)


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(
        status="ok",
        env=os.getenv("ENV_NAME", "unknown"),
    )
