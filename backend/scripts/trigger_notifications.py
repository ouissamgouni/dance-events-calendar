"""Manually trigger one notification dispatch pass.

Dev/scenario ergonomics wrapper around
``backend.services.scheduler.run_notification_dispatch_once``. Uses the
same DB engine as the running app, so simply run under the env you want
to target (dev, scenario, staging.local):

    task notify:trigger:dev
    SCENARIO=profile-match-email task notify:trigger:scenario
    task notify:trigger:staging:local

For remote envs (staging/prod) DB isn't reachable — call the admin HTTP
endpoint (``notify:trigger:staging:remote`` / ``notify:trigger:prod``).

The CLI is verbose on purpose: dispatch is a pipeline (reminders →
interest-matcher → activity digest) with several silent gates (env flags,
per-user prefs, per-profile flags, batch-delay window, max-age window). A
"nothing happened" run has half a dozen possible causes — the diagnostic
output surfaces which gate held things back so you don't have to guess.
"""

from __future__ import annotations

import argparse
import json
import logging
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlmodel import Session, select

from backend.db.database import get_engine
from backend.db.models import (
    CachedEvent,
    Notification,
    SiteSetting,
    User,
    UserInterestProfile,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def _utcnow_naive() -> datetime:
    # datetime.utcnow() is deprecated in 3.12+; keep naive-UTC semantics
    # that the rest of the notification pipeline stores in the DB.
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# Introspection helpers
# ---------------------------------------------------------------------------


def _reset_last_scan() -> str | None:
    """Delete the interest_notification_last_scan marker. Returns prior value."""
    from backend.services.interest_notification_service import _LAST_SCAN_KEY

    with Session(get_engine()) as session:
        row = session.get(SiteSetting, _LAST_SCAN_KEY)
        if row is None:
            return None
        prior = row.value
        session.delete(row)
        session.commit()
        return prior


def _env_gates() -> dict:
    from backend.config.loader import (
        get_activity_digest_email_enabled,
        get_interest_match_notifications_enabled,
        get_web_push_enabled,
    )

    return {
        "INTEREST_MATCH_NOTIFICATIONS_ENABLED": get_interest_match_notifications_enabled(),
        "ACTIVITY_DIGEST_EMAIL_ENABLED": get_activity_digest_email_enabled(),
        "WEB_PUSH_ENABLED": get_web_push_enabled(),
    }


def _resolve_user(session: Session, user_email: str) -> User | None:
    return session.exec(select(User).where(User.email == user_email.lower())).first()


def _user_prefs(user: User) -> dict:
    # Phase G: per-feature × per-channel matrix.
    return {
        "email_event_reminders_enabled": user.email_event_reminders_enabled,
        "email_social_activity_enabled": user.email_social_activity_enabled,
        "email_interest_matches_enabled": user.email_interest_matches_enabled,
        "push_event_reminders_enabled": user.push_event_reminders_enabled,
        "push_social_activity_enabled": user.push_social_activity_enabled,
        "push_interest_matches_enabled": user.push_interest_matches_enabled,
    }


def _user_profile_summary(session: Session, user_id: int) -> dict:
    profiles = session.exec(
        select(UserInterestProfile).where(UserInterestProfile.user_id == user_id)
    ).all()
    return {
        "total": len(profiles),
        "matches_enabled": sum(1 for p in profiles if p.matches_enabled),
    }


def _interest_scan_window(session: Session) -> dict:
    """Return the interest matcher's current scan window bounds."""
    from backend.services.interest_notification_service import (
        _INITIAL_LOOKBACK,
        _LAST_SCAN_KEY,
    )

    row = session.get(SiteSetting, _LAST_SCAN_KEY)
    now = _utcnow_naive()
    if row and row.value:
        try:
            since = datetime.fromisoformat(row.value)
            source = "site_setting"
        except ValueError:
            since = now - _INITIAL_LOOKBACK
            source = "initial_lookback (bad site_setting value)"
    else:
        since = now - _INITIAL_LOOKBACK
        source = "initial_lookback (no site_setting yet)"
    return {
        "last_scan": since.isoformat(timespec="seconds") + "Z",
        "now": now.isoformat(timespec="seconds") + "Z",
        "window_seconds": int((now - since).total_seconds()),
        "source": source,
    }


def _summarize_pending(session: Session, user: User | None) -> dict:
    """Snapshot un-emailed / unread interest_event rows for verification."""
    stmt = select(Notification).where(Notification.kind == "interest_event")
    if user is not None:
        stmt = stmt.where(Notification.recipient_user_id == user.id)
    rows = session.exec(stmt).all()
    return {
        "interest_notifications_total": len(rows),
        "un_emailed": sum(1 for r in rows if r.emailed_at is None),
        "unread": sum(1 for r in rows if r.read_at is None),
    }


def _bucket_pending_activity(session: Session, user: User | None) -> dict:
    """Explain why un-emailed activity rows aren't being shipped.

    Buckets un-emailed rows across all ACTIVITY_KINDS by the specific gate
    that's holding them back. Turns "digests=0" from a mystery into an
    answer. Post Phase G the opt-out gate splits per-feature; digest
    delivery is also gated by the per-user scheduled slot.
    """
    from datetime import timezone

    from backend.services.activity_email import (
        ACTIVITY_KINDS,
        CHANNEL_FLAG,
        FEATURE_BY_KIND,
        _MAX_AGE,
        _is_user_in_slot,
        _parse_schedule,
    )
    from backend.services.app_settings import get_activity_digest_schedule

    now = _utcnow_naive()
    now_utc = now.replace(tzinfo=timezone.utc)
    cutoff_old = now - _MAX_AGE
    weekdays, hour, minute = _parse_schedule(get_activity_digest_schedule())

    stmt = (
        select(Notification)
        .where(Notification.emailed_at.is_(None))  # type: ignore[union-attr]
        .where(Notification.kind.in_(ACTIVITY_KINDS))  # type: ignore[union-attr]
    )
    if user is not None:
        stmt = stmt.where(Notification.recipient_user_id == user.id)
    pending = session.exec(stmt).all()

    recipient_ids = {n.recipient_user_id for n in pending}
    recipients = {
        u.id: u
        for u in session.exec(
            select(User).where(User.id.in_(recipient_ids))  # type: ignore[union-attr]
        ).all()
    }

    ready = off_schedule = too_old = opted_out_social = opted_out_interest = 0
    deleted = 0
    for n in pending:
        recipient = recipients.get(n.recipient_user_id)
        if recipient is None or recipient.deleted_at is not None:
            deleted += 1
            continue
        feature = FEATURE_BY_KIND.get(n.kind)
        email_flag = (
            getattr(recipient, CHANNEL_FLAG[("email", feature)], True)
            if feature
            else True
        )
        if not email_flag:
            if feature == "interest_matches":
                opted_out_interest += 1
            else:
                opted_out_social += 1
            continue
        if n.created_at < cutoff_old:
            too_old += 1
            continue
        if not _is_user_in_slot(recipient, now_utc, weekdays, hour, minute):
            off_schedule += 1
            continue
        ready += 1

    return {
        "total_un_emailed": len(pending),
        "ready_to_send_now": ready,
        "waiting_for_scheduled_slot": off_schedule,
        "older_than_max_age": too_old,
        "opted_out_social": opted_out_social,
        "opted_out_interest": opted_out_interest,
        "recipient_deleted_or_missing": deleted,
        "digest_schedule": get_activity_digest_schedule(),
        "max_age_seconds": int(_MAX_AGE.total_seconds()),
    }


def _events_in_scan_window(session: Session) -> int:
    """Count events currently in the interest matcher's candidate window."""
    from backend.services.interest_notification_service import (
        _INITIAL_LOOKBACK,
        _LAST_SCAN_KEY,
    )

    now = _utcnow_naive()
    row = session.get(SiteSetting, _LAST_SCAN_KEY)
    if row and row.value:
        try:
            since = datetime.fromisoformat(row.value)
        except ValueError:
            since = now - _INITIAL_LOOKBACK
    else:
        since = now - _INITIAL_LOOKBACK
    return len(
        session.exec(
            select(CachedEvent)
            .where(CachedEvent.deleted_at.is_(None))  # type: ignore[union-attr]
            .where(CachedEvent.is_hidden == False)  # noqa: E712
            .where(CachedEvent.updated_at > since)
            .where(CachedEvent.updated_at <= now)
            .where(CachedEvent.start > now)
            .where(CachedEvent.latitude.is_not(None))  # type: ignore[union-attr]
            .where(CachedEvent.longitude.is_not(None))  # type: ignore[union-attr]
        ).all()
    )


# ---------------------------------------------------------------------------
# --immediate-emails: force-flag wrapper (previously monkey-patched
# _BATCH_DELAY; cadence-based delivery replaced that mechanism).
# ---------------------------------------------------------------------------


@contextmanager
def _immediate_emails():
    """Retained as a no-op context manager for backwards compatibility.

    The old implementation zeroed ``activity_email._BATCH_DELAY``.
    Delivery is now scheduled per-user; the ``force=True`` kwarg on
    ``activity_email.run_once`` is passed at the dispatch call site
    instead.
    """
    yield


# ---------------------------------------------------------------------------
# Output rendering
# ---------------------------------------------------------------------------


def _bar() -> str:
    return "─" * 60


def _fmt_kv(items: dict, indent: int = 2) -> str:
    pad = " " * indent
    return "\n".join(f"{pad}{k:<38} = {v}" for k, v in items.items())


def _render_terse(report: dict) -> str:
    """One-screen summary: dispatch counts, before/after delta, and only the
    non-zero suppression buckets that explain why rows didn't ship.

    Use ``--verbose`` for the full gates/scan-window/prefs breakdown.
    """
    lines: list[str] = []
    sw = report["scan_window"]
    only = report.get("only", "all")
    user_scope = f" user={report['user']['email']}" if report.get("user") else ""
    lines.append(
        f"dispatch only={only}{user_scope} "
        f"scan_window={sw['window_seconds']}s "
        f"events_in_window={sw.get('events_in_window', '?')}"
    )

    stats = report.get("stats") or {}
    if stats.get("skipped") == "locked":
        lines.append("  SKIPPED: advisory lock held by another instance")
    else:
        for phase in ("reminders", "interest", "activity"):
            v = stats.get(phase)
            if v is not None:
                lines.append(f"  {phase:<9}: {v}")

    b, af = report.get("before"), report.get("after")
    if b and af:
        delta_total = (
            af["interest_notifications_total"] - b["interest_notifications_total"]
        )
        delta_emailed = b["un_emailed"] - af["un_emailed"]
        delta_read = b["unread"] - af["unread"]
        lines.append(
            f"  delta    : +{delta_total} created, "
            f"{delta_emailed} newly emailed, {delta_read} newly read"
        )

    diag = report.get("activity_diag") or {}
    # Only surface suppression buckets that actually held rows back.
    suppression = {
        "off-schedule": diag.get("waiting_for_scheduled_slot", 0),
        "too-old": diag.get("older_than_max_age", 0),
        "opted-out-social": diag.get("opted_out_social", 0),
        "opted-out-interest": diag.get("opted_out_interest", 0),
        "recipient-deleted": diag.get("recipient_deleted_or_missing", 0),
    }
    problem = {k: v for k, v in suppression.items() if v}
    if problem:
        lines.append(
            "  suppressed: "
            + ", ".join(f"{k}={v}" for k, v in problem.items())
            + "  (run with --verbose for gate breakdown)"
        )

    if report.get("reset_scan", {}).get("cleared"):
        lines.append(
            f"  --reset-scan: cleared marker "
            f"(prior={report['reset_scan']['prior_value']})"
        )
    if report.get("immediate_emails"):
        lines.append("  --immediate-emails: force=True bypassed schedule slot")

    return "\n".join(lines)


def _render_text(report: dict) -> str:
    lines: list[str] = []
    lines.append(_bar())
    lines.append("Notification dispatch pass")
    lines.append(_bar())

    if "reset_scan" in report:
        rs = report["reset_scan"]
        lines.append(
            "  --reset-scan: cleared last_scan marker "
            f"(prior value: {rs['prior_value']})"
            if rs["cleared"]
            else "  --reset-scan: no marker present, nothing to clear"
        )

    lines.append("")
    lines.append("Env gates (skip the whole sub-task when false):")
    lines.append(_fmt_kv(report["env_gates"]))

    if report.get("user"):
        u = report["user"]
        lines.append("")
        lines.append(f"User: {u['email']} (id={u['id']})")
        lines.append("  channels:")
        lines.append(_fmt_kv(u["prefs"], indent=4))
        lines.append(
            f"  interest profiles                      = "
            f"{u['profiles']['matches_enabled']} of {u['profiles']['total']} with matches_enabled"
        )

    sw = report["scan_window"]
    lines.append("")
    lines.append("Interest matcher scan window:")
    lines.append(f"  last_scan = {sw['last_scan']}   (source: {sw['source']})")
    lines.append(f"  now       = {sw['now']}")
    lines.append(
        f"  window    = {sw['window_seconds']}s   "
        f"events currently in window: {sw['events_in_window']}"
    )

    scope = f"for {report['user']['email']}" if report.get("user") else "(all users)"
    if report.get("before"):
        lines.append("")
        lines.append(f"Before dispatch (interest_event rows {scope}):")
        lines.append(_fmt_kv(report["before"]))

    lines.append("")
    lines.append(_bar())
    only = report.get("only", "all")
    lines.append(f"Dispatch result (phase: {only})")
    lines.append(_bar())
    stats = report["stats"]
    if stats.get("skipped") == "locked":
        lines.append(
            "  SKIPPED: another instance holds the Postgres advisory lock "
            "for this tick."
        )
    else:
        r = stats.get("reminders")
        i = stats.get("interest")
        a = stats.get("activity")
        if r is not None:
            lines.append(f"  reminders : {r}")
        if i is not None:
            lines.append(f"  interest  : {i}")
        if a is not None:
            lines.append(f"  activity  : {a}")
        if only != "all":
            lines.append(
                f"             (--only {only}: other phases skipped in this run)"
            )
        if report.get("immediate_emails"):
            lines.append(
                "             (--immediate-emails: activity digest schedule "
                "check bypassed via force=True)"
            )

    diag = report.get("activity_diag")
    if diag:
        lines.append("")
        lines.append(
            "Why activity digests didn't ship (un-emailed row breakdown, "
            "post-dispatch):"
        )
        lines.append(f"  total un-emailed          : {diag['total_un_emailed']}")
        lines.append(f"  ready to send now         : {diag['ready_to_send_now']}")
        lines.append(
            f"  off-schedule (waiting)    : {diag['waiting_for_scheduled_slot']}   "
            f"→ recipient not in their {diag['digest_schedule']!r} local slot; "
            "re-run at their next scheduled time or pass --immediate-emails"
        )
        lines.append(
            f"  older than max_age ({diag['max_age_seconds']}s) : "
            f"{diag['older_than_max_age']}   "
            "→ permanently skipped (backlog protection)"
        )
        lines.append(
            f"  opted out (social)        : {diag['opted_out_social']}   "
            "→ user.email_social_activity_enabled = false"
        )
        lines.append(
            f"  opted out (interest)      : {diag['opted_out_interest']}   "
            "→ user.email_interest_matches_enabled = false"
        )
        lines.append(
            f"  recipient deleted/missing : {diag['recipient_deleted_or_missing']}"
        )

    if report.get("after"):
        lines.append("")
        lines.append(f"After dispatch (interest_event rows {scope}):")
        lines.append(_fmt_kv(report["after"]))
        b, af = report["before"], report["after"]
        delta_total = (
            af["interest_notifications_total"] - b["interest_notifications_total"]
        )
        delta_emailed = b["un_emailed"] - af["un_emailed"]
        delta_read = b["unread"] - af["unread"]
        lines.append(
            f"  delta: +{delta_total} created, "
            f"{delta_emailed} newly emailed, {delta_read} newly read"
        )

    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Trigger one notification dispatch pass (reminders + interest "
            "matcher + activity digest). Prints a diagnostic report of "
            "gates, scan window, and why any un-emailed rows aren't shipping."
        )
    )
    parser.add_argument(
        "--reset-scan",
        action="store_true",
        help=(
            "Delete the interest_notification_last_scan SiteSetting first so "
            "the matcher rescans the last 24h window."
        ),
    )
    parser.add_argument(
        "--user",
        default=None,
        help=(
            "Email of a user to inspect (prefs, profile count, before/after "
            "interest_event snapshot). Also scopes the activity-digest "
            "diagnostic to this user."
        ),
    )
    parser.add_argument(
        "--immediate-emails",
        action="store_true",
        help=(
            "Bypass the per-user activity digest schedule for this run so "
            "any pending rows ship immediately regardless of the recipient's "
            "local scheduled slot. Dev/admin trigger only; the periodic "
            "scheduler should always respect the cadence."
        ),
    )
    parser.add_argument(
        "--only",
        choices=("all", "reminders", "matcher", "emails"),
        default="all",
        help=(
            "Run only one phase of the dispatch pipeline. Phases correspond "
            "to distinct business steps: 'reminders' (event-reminder emails/"
            "pushes), 'matcher' (interest_notification_service — create rows "
            "only, no email), 'emails' (activity_email — ship pending "
            "digests only, no matcher). 'all' (default) runs the full "
            "scheduler tick under the Postgres advisory lock."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the full diagnostic report as JSON instead of prose.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help=(
            "Emit the full multi-section diagnostic (env gates, per-user "
            "prefs, scan-window details, before/after snapshots, all "
            "suppression buckets). Default output is a ~6-line summary."
        ),
    )
    args = parser.parse_args()

    report: dict = {}

    if args.reset_scan:
        prior = _reset_last_scan()
        report["reset_scan"] = {"cleared": prior is not None, "prior_value": prior}

    report["env_gates"] = _env_gates()
    report["immediate_emails"] = args.immediate_emails

    with Session(get_engine()) as session:
        user = _resolve_user(session, args.user) if args.user else None
        if args.user and user is None:
            msg = f"user not found: {args.user}"
            print(json.dumps({"error": msg}) if args.json else f"ERROR: {msg}")
            return 1
        if user is not None:
            report["user"] = {
                "email": user.email,
                "id": user.id,
                "prefs": _user_prefs(user),
                "profiles": _user_profile_summary(session, user.id),
            }
        sw = _interest_scan_window(session)
        sw["events_in_window"] = _events_in_scan_window(session)
        report["scan_window"] = sw
        report["before"] = _summarize_pending(session, user)

    # Imported lazily so --help works even without a DB configured.
    def _dispatch() -> dict:
        if args.only == "all":
            from backend.services.scheduler import run_notification_dispatch_once

            return run_notification_dispatch_once(
                force_activity_digest=args.immediate_emails
            )
        # Per-phase invocations skip the Postgres advisory lock (dev-only
        # ergonomics). Each sub-service opens its own session/transaction.
        from backend.services import (
            activity_email,
            interest_notification_service,
            reminder_service,
        )

        if args.only == "reminders":
            return {"reminders": reminder_service.run_once(), "only": "reminders"}
        if args.only == "matcher":
            return {
                "interest": interest_notification_service.run_once(),
                "only": "matcher",
            }
        # args.only == "emails"
        return {
            "activity": activity_email.run_once(force=args.immediate_emails),
            "only": "emails",
        }

    report["only"] = args.only
    if args.immediate_emails:
        with _immediate_emails():
            report["stats"] = _dispatch()
    else:
        report["stats"] = _dispatch()

    with Session(get_engine()) as session:
        user = _resolve_user(session, args.user) if args.user else None
        report["after"] = _summarize_pending(session, user)
        report["activity_diag"] = _bucket_pending_activity(session, user)

    if args.json:
        print(json.dumps(report, default=str, indent=2))
    elif args.verbose:
        print(_render_text(report))
    else:
        print(_render_terse(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
