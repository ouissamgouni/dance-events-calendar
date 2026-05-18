#!/usr/bin/env python3
"""Reset (wipe all data for) an Umami Cloud website. DESTRUCTIVE.

Calls ``POST https://api.umami.is/api/websites/{id}/reset`` with the
configured ``UMAMI_API_KEY``. This is the documented Umami Cloud reset
endpoint; it removes all events for the website while keeping the
website definition (and its ID) intact, so no frontend rebuild is needed
afterwards.

For self-hosted (dev / scenario) instances, prefer recreating the
docker volume via the existing ``task start:dev:db RESET=1`` /
``task stop:scenario`` flows — this script is for Cloud only.

Safety: refuses to run unless ``CONFIRM=WIPE-<ENV_NAME>`` is set, and
prints the target website ID + env first.

Required env vars:
    ENV_NAME                 e.g. ``staging`` or ``prod``
    CONFIRM                  must equal ``WIPE-<ENV_NAME>``
    UMAMI_API_KEY            Umami Cloud API key (per-env)
    VITE_UMAMI_WEBSITE_ID    Website UUID to reset

Optional:
    UMAMI_API_BASE           defaults to ``https://api.umami.is``

Usage::

    ENV_NAME=staging \\
    CONFIRM=WIPE-staging \\
    UMAMI_API_KEY=... \\
    VITE_UMAMI_WEBSITE_ID=d8f3134d-... \\
    python scripts/reset_umami_cloud.py
"""

from __future__ import annotations

import json
import logging
import os
import sys
import urllib.error
import urllib.request

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def main() -> int:
    env_name = os.getenv("ENV_NAME", "").strip()
    if not env_name:
        logger.error("Aborting: ENV_NAME is required.")
        return 2

    expected = f"WIPE-{env_name}"
    confirm = os.getenv("CONFIRM", "")
    api_key = os.getenv("UMAMI_API_KEY", "").strip()
    website_id = os.getenv("VITE_UMAMI_WEBSITE_ID", "").strip()
    api_base = os.getenv("UMAMI_API_BASE", "https://api.umami.is").rstrip("/")

    if not api_key:
        logger.error("Aborting: UMAMI_API_KEY is required.")
        return 2
    if not website_id:
        logger.error("Aborting: VITE_UMAMI_WEBSITE_ID is required.")
        return 2

    logger.warning(
        "ENV_NAME=%s — target Umami website: %s (via %s)",
        env_name,
        website_id,
        api_base,
    )

    if confirm != expected:
        logger.error(
            "Aborting: CONFIRM must be set to %r (got %r). Re-run with "
            "CONFIRM=%s to proceed.",
            expected,
            confirm,
            expected,
        )
        return 2

    url = f"{api_base}/api/websites/{website_id}/reset"
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "x-umami-api-key": api_key,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            logger.info("HTTP %s — %s", resp.status, body)
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict) and payload.get("ok") is True:
                logger.info("Done. Website %s reset.", website_id)
                return 0
            logger.error("Unexpected response payload; treating as failure.")
            return 1
    except urllib.error.HTTPError as e:
        logger.error("HTTP %s — %s", e.code, e.read().decode("utf-8", errors="replace"))
        return 1
    except urllib.error.URLError as e:
        logger.error("Network error: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
