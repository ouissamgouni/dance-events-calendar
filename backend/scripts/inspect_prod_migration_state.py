"""Read-only probe: determine which alembic migrations have been *physically*
applied to the target database, independently of the ``alembic_version``
tracker.

Motivation
----------

Prod's ``alembic_version`` is stamped at ``ca7ab554855a`` but the schema on
disk may have advanced further (or not) due to manual DDL or a broken CI
step that ran ``upgrade head`` without persisting the version. Before
running any ``alembic upgrade`` or ``alembic stamp``, we need to know
*which revision the schema actually matches*.

This script inspects the live schema for each migration between the current
stamped revision and ``head`` and reports whether the migration's user-
visible side-effects are present. It **never writes**. Output is a table
plus a recommended ``alembic stamp <rev>`` command that the operator can
review and run manually.

Usage
-----

    # Against local .env (usually dev)
    ../.venv/bin/python -m backend.scripts.inspect_prod_migration_state

    # Against prod via one-shot DATABASE_URL (recommended: use a Fly ssh
    # console / Neon read-replica connection string)
    DATABASE_URL=postgres://... ../.venv/bin/python \
        -m backend.scripts.inspect_prod_migration_state

Exit codes
----------
  0 = report generated
  2 = connection or introspection error
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass
from typing import Callable

import sqlalchemy as sa
from sqlalchemy.engine import Engine

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Probe:
    rev: str
    description: str
    # Returns (applied, evidence_str). "applied" is None when we can't tell
    # (e.g. data-only migrations without a stable schema fingerprint).
    check: Callable[[Engine], tuple[bool | None, str]]


# ---------------------------------------------------------------------------
# Probe helpers
# ---------------------------------------------------------------------------


def _has_column(engine: Engine, table: str, column: str) -> bool:
    insp = sa.inspect(engine)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def _has_table(engine: Engine, table: str) -> bool:
    return table in sa.inspect(engine).get_table_names()


def _scalar(engine: Engine, sql: str) -> int | None:
    try:
        with engine.connect() as conn:
            return conn.execute(sa.text(sql)).scalar()
    except sa.exc.SQLAlchemyError:
        return None


# ---------------------------------------------------------------------------
# Probe registry — one per candidate revision from ca7ab554855a → head.
# Order matches migration chain top-down (oldest first).
# ---------------------------------------------------------------------------


def _probe_4f38e516ed38(engine: Engine) -> tuple[bool | None, str]:
    """rename_tag_group_scope_to_reach — data rename in tag_groups."""
    if not _has_table(engine, "tag_groups"):
        return False, "tag_groups table missing"
    reach = _scalar(engine, "SELECT COUNT(*) FROM tag_groups WHERE slug = 'reach'")
    scope = _scalar(engine, "SELECT COUNT(*) FROM tag_groups WHERE slug = 'scope'")
    if reach and reach > 0 and (scope or 0) == 0:
        return True, f"tag_groups: reach={reach}, scope={scope}"
    if (scope or 0) > 0 and (reach or 0) == 0:
        return False, f"tag_groups: reach={reach}, scope={scope}"
    return None, f"ambiguous: reach={reach}, scope={scope}"


def _probe_7c1d9e2a6b4f(engine: Engine) -> tuple[bool | None, str]:
    """add_interest_profiles — creates user_interest_profiles + tag join."""
    if _has_table(engine, "user_interest_profiles"):
        return True, "user_interest_profiles table exists"
    return False, "user_interest_profiles table missing"


def _probe_8b3c4d5e6f7a(engine: Engine) -> tuple[bool | None, str]:
    """add_notification_context — nullable notifications.context column."""
    if _has_column(engine, "notifications", "context"):
        return True, "notifications.context present"
    return False, "notifications.context missing"


def _probe_9d5e7a3b1f2c(engine: Engine) -> tuple[bool | None, str]:
    """add_interest_profile_is_active — user_interest_profiles.is_active."""
    if not _has_table(engine, "user_interest_profiles"):
        return False, "table missing (upstream migration not applied)"
    if _has_column(engine, "user_interest_profiles", "is_active"):
        return True, "is_active column present"
    return False, "is_active column missing"


def _probe_e6f7a8b9c0d1(engine: Engine) -> tuple[bool | None, str]:
    """normalize_interest_profile_geo_to_bbox — drops geo_kind/center_*/radius_km."""
    if not _has_table(engine, "user_interest_profiles"):
        return False, "table missing"
    legacy = {"geo_kind", "center_lat", "center_lng", "radius_km"}
    insp = sa.inspect(engine)
    cols = {c["name"] for c in insp.get_columns("user_interest_profiles")}
    still_present = legacy & cols
    bbox_cols = {"min_lat", "min_lng", "max_lat", "max_lng"} <= cols
    if not still_present and bbox_cols:
        return True, "legacy geo columns dropped, bbox cols present"
    if still_present:
        return False, f"legacy geo cols still present: {sorted(still_present)}"
    return None, "bbox cols absent — schema unexpected"


def _probe_f7a8b9c0d1e2(engine: Engine) -> tuple[bool | None, str]:
    """backfill_default_interest_profile — data-only, no schema fingerprint.

    We can *hint* at application by checking whether every non-deleted
    onboarded user has at least one interest_profile row, but on a fresh
    prod that ratio is trivially 0/0. Report as ambiguous.
    """
    if not _has_table(engine, "user_interest_profiles"):
        return False, "upstream table missing"
    total_users = _scalar(engine, "SELECT COUNT(*) FROM users WHERE deleted_at IS NULL")
    users_with_profile = _scalar(
        engine,
        "SELECT COUNT(DISTINCT user_id) FROM user_interest_profiles",
    )
    if not total_users:
        return None, "no users to sample"
    coverage = (users_with_profile or 0) / total_users
    verdict = None if coverage < 0.5 else True
    return verdict, (
        f"{users_with_profile}/{total_users} users have >=1 profile "
        f"(coverage={coverage:.0%})"
    )


def _probe_g2h3i4j5k6l7(engine: Engine) -> tuple[bool | None, str]:
    """notification gating matrix — adds 6 email_*/push_* cols, drops 4 legacy."""
    new = {
        "email_event_reminders_enabled",
        "email_social_activity_enabled",
        "email_interest_matches_enabled",
        "push_event_reminders_enabled",
        "push_social_activity_enabled",
        "push_interest_matches_enabled",
    }
    legacy = {
        "reminder_email_enabled",
        "activity_email_enabled",
        "push_enabled",
        "interest_notifications_enabled",
    }
    insp = sa.inspect(engine)
    if "users" not in insp.get_table_names():
        return False, "users table missing"
    cols = {c["name"] for c in insp.get_columns("users")}
    have_new = new <= cols
    legacy_present = legacy & cols
    if have_new and not legacy_present:
        return True, "6 new cols present, all 4 legacy dropped"
    if not (new & cols) and legacy_present:
        # No new cols and at least one legacy col still present → not applied.
        # (Some legacy cols may already be absent because their creating
        # migration was never applied either — still counts as NO for us.)
        return False, f"new cols absent, legacy still present: {sorted(legacy_present)}"
    return None, (
        f"partial: new_present={sorted(new & cols)}, "
        f"legacy_remaining={sorted(legacy_present)}"
    )


def _probe_h3i4j5k6l7m8(engine: Engine) -> tuple[bool | None, str]:
    """add onboarding_version + last_digest_sent_at to users."""
    ov = _has_column(engine, "users", "onboarding_version")
    ldsa = _has_column(engine, "users", "last_digest_sent_at")
    if ov and ldsa:
        return True, "both cols present"
    if not ov and not ldsa:
        return False, "both cols missing"
    return None, f"partial: onboarding_version={ov}, last_digest_sent_at={ldsa}"


def _probe_i4j5k6l7m8n9(engine: Engine) -> tuple[bool | None, str]:
    """rename notification-gate site_settings keys."""
    if not _has_table(engine, "site_settings"):
        return False, "site_settings table missing"
    new_keys = {
        "event_reminders_enabled",
        "activity_digest_email_enabled",
        "interest_match_notifications_enabled",
        "web_push_enabled",
    }
    old_keys = {
        "reminders_enabled",
        "activity_email_enabled",
        "interest_notifications_enabled",
        "webpush_enabled",
    }
    with engine.connect() as conn:
        present = {
            r[0]
            for r in conn.execute(
                sa.text("SELECT key FROM site_settings WHERE key = ANY(:keys)"),
                {"keys": list(new_keys | old_keys)},
            )
        }
    new_seen = new_keys & present
    old_seen = old_keys & present
    if new_seen and not old_seen:
        return True, f"renamed keys present: {sorted(new_seen)}"
    if old_seen and not new_seen:
        return False, f"only legacy keys present: {sorted(old_seen)}"
    if not new_seen and not old_seen:
        return None, "no notification-gate rows exist (defaults active) — inconclusive"
    return None, f"mixed: new={sorted(new_seen)}, legacy={sorted(old_seen)}"


PROBES: tuple[Probe, ...] = (
    Probe("4f38e516ed38", "rename_tag_group_scope_to_reach", _probe_4f38e516ed38),
    Probe("7c1d9e2a6b4f", "add_interest_profiles", _probe_7c1d9e2a6b4f),
    Probe("8b3c4d5e6f7a", "add_notification_context", _probe_8b3c4d5e6f7a),
    Probe("9d5e7a3b1f2c", "add_interest_profile_is_active", _probe_9d5e7a3b1f2c),
    Probe(
        "e6f7a8b9c0d1", "normalize_interest_profile_geo_to_bbox", _probe_e6f7a8b9c0d1
    ),
    Probe("f7a8b9c0d1e2", "backfill_default_interest_profile", _probe_f7a8b9c0d1e2),
    Probe("g2h3i4j5k6l7", "notification gating matrix (Phase G)", _probe_g2h3i4j5k6l7),
    Probe(
        "h3i4j5k6l7m8",
        "add onboarding_version + last_digest_sent_at",
        _probe_h3i4j5k6l7m8,
    ),
    Probe(
        "i4j5k6l7m8n9",
        "rename notification-gate site_settings keys",
        _probe_i4j5k6l7m8n9,
    ),
)

BASELINE_STAMPED = "ca7ab554855a"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _read_stamped_version(engine: Engine) -> str | None:
    if "alembic_version" not in sa.inspect(engine).get_table_names():
        return None
    return _scalar(engine, "SELECT version_num FROM alembic_version LIMIT 1")  # type: ignore[return-value]


def main() -> int:
    # Prefer explicit DATABASE_URL — never fall back to dev seed engine
    # silently when running against prod.
    url = os.environ.get("DATABASE_URL")
    if not url:
        logger.error(
            "DATABASE_URL is required. Export the connection string of the "
            "database you want to probe (e.g. `DATABASE_URL=postgres://...`)."
        )
        return 2

    engine = sa.create_engine(url)
    try:
        with engine.connect():
            pass
    except sa.exc.SQLAlchemyError as exc:
        logger.error("Failed to connect: %s", exc)
        return 2

    stamped = _read_stamped_version(engine)
    logger.info("=" * 78)
    logger.info(
        "alembic_version tracker: %s", stamped or "(alembic_version table missing)"
    )
    logger.info("baseline (assumed applied): %s", BASELINE_STAMPED)
    logger.info("=" * 78)
    logger.info("")
    logger.info(
        "%-14s | %-8s | %-45s | %s", "Revision", "Applied", "Description", "Evidence"
    )
    logger.info("-" * 78)

    highest_confirmed: str = BASELINE_STAMPED
    first_gap: str | None = None
    for probe in PROBES:
        try:
            applied, evidence = probe.check(engine)
        except sa.exc.SQLAlchemyError as exc:
            applied, evidence = None, f"probe error: {exc}"

        label = {True: "YES", False: "NO", None: "?"}[applied]
        logger.info(
            "%-14s | %-8s | %-45s | %s",
            probe.rev,
            label,
            probe.description[:45],
            evidence,
        )
        if applied is True and first_gap is None:
            highest_confirmed = probe.rev
        elif applied is False and first_gap is None:
            first_gap = probe.rev

    logger.info("")
    logger.info("=" * 78)
    logger.info("Analysis")
    logger.info("=" * 78)
    logger.info(
        "Highest revision with confirmed schema evidence: %s", highest_confirmed
    )
    if first_gap:
        logger.info("First gap (schema-absent) at revision:            %s", first_gap)
    logger.info("")
    if highest_confirmed != stamped:
        logger.info(
            "Recommended reconciliation (RUN MANUALLY after reviewing rows above):\n"
            "    alembic stamp %s\n"
            "    alembic upgrade head",
            highest_confirmed,
        )
    else:
        logger.info("Tracker matches highest confirmed rev — no stamp required.")
        logger.info("    alembic upgrade head")

    return 0


if __name__ == "__main__":
    sys.exit(main())
