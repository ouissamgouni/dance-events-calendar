"""Root fixtures shared by all backend tests.

Disables outbound network side-effects (SMTP email) for the whole test
session. Locally the test task loads ``config/base.env`` which points at the
real Brevo SMTP relay, so without this every email-sending code path opens a
real SMTP connection — ``socket.getfqdn()`` alone blocks ~5s on reverse-DNS
plus ~1s for the TCP/TLS handshake. That added well over a minute to the
suite (ratings / promo-codes / organizer-claims / notifications tests). No
test asserts a real SMTP send, so we force the configured host empty, which
makes ``_send_email`` short-circuit exactly as it does in production when SMTP
is unconfigured.
"""

import os
import tempfile
from pathlib import Path
from uuid import uuid4

_TEST_DATABASE_PATH = Path(tempfile.gettempdir()) / f"movida-pytest-{uuid4().hex}.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DATABASE_PATH}"
os.environ["GOOGLE_CLIENT_ID"] = "test-client-id"
os.environ["ADMIN_EMAIL"] = "admin@example.com"
os.environ["SESSION_SECRET"] = "test-session-secret"
os.environ["CALENDAR_SERVICE"] = "mock"
os.environ["DEV_AUTH"] = "true"
os.environ["OBJECT_STORAGE_PROVIDER"] = "minio"
os.environ["AUTO_SYNC_SCHEDULER_ENABLED"] = "false"
os.environ["NOTIFICATION_SCHEDULER_ENABLED"] = "false"

import pytest


@pytest.fixture(autouse=True, scope="session")
def _disable_smtp():
    saved = {k: os.environ.get(k) for k in ("SMTP_HOST", "SMTP_FROM")}
    os.environ["SMTP_HOST"] = ""
    os.environ["SMTP_FROM"] = ""
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@pytest.fixture(autouse=True, scope="session")
def _initialize_test_database():
    from backend.db import database

    database.init_db()
    try:
        yield
    finally:
        if database._engine is not None:
            database._engine.dispose()
            database._engine = None
        _TEST_DATABASE_PATH.unlink(missing_ok=True)
