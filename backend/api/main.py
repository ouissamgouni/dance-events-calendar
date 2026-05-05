import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from backend.api.routes.admin import router as admin_router
from backend.api.routes.attendance import router as attendance_router
from backend.api.routes.auth import router as auth_router
from backend.api.routes.config import router as config_router
from backend.api.routes.events import router as events_router
from backend.api.routes.export import router as export_router
from backend.api.routes.ratings import router as ratings_router
from backend.api.routes.settings import router as settings_router
from backend.api.routes.sharing import router as sharing_router
from backend.api.routes.suggestions import router as suggestions_router
from backend.api.routes.tags import router as tags_router
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


_SECURITY_HEADERS = [
    (b"x-frame-options", b"DENY"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"strict-origin-when-cross-origin"),
    (b"strict-transport-security", b"max-age=31536000; includeSubDomains"),
    (b"x-permitted-cross-domain-policies", b"none"),
]


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message) -> None:
            if message["type"] == "http.response.start":
                message = {
                    **message,
                    "headers": list(message.get("headers", [])) + _SECURITY_HEADERS,
                }
            await send(message)

        await self.app(scope, receive, send_with_headers)


app = FastAPI(title="Movida", lifespan=lifespan)
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(SecurityHeadersMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request, exc):
    return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})


app.include_router(auth_router)
app.include_router(events_router)
app.include_router(export_router)
app.include_router(tracking_router)
app.include_router(attendance_router)
app.include_router(sharing_router)
app.include_router(admin_router)
app.include_router(settings_router)
app.include_router(config_router)
app.include_router(suggestions_router)
app.include_router(tags_router)
app.include_router(ratings_router)


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok")
