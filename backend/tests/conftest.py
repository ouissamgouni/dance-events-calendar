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

import pytest


@pytest.fixture(autouse=True, scope="session")
def _disable_smtp():
    import os

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
