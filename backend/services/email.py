import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape

from backend.config.loader import get_public_app_url, get_smtp_config
from backend.services.email_tokens import make_unsubscribe_token

logger = logging.getLogger(__name__)
APP_NAME = "Movida"


def _prefixed_subject(subject: str) -> str:
    if subject.strip().lower().startswith(APP_NAME.lower()):
        return subject
    return f"{APP_NAME}: {subject}"


def _send_email(to_addr: str, subject: str, html: str, kind: str) -> bool:
    """Send a single HTML email. Returns True if dispatched.

    Skips silently (returns False) if SMTP is not configured or the send
    fails, so callers never raise into request/loop paths.
    """
    config = get_smtp_config()
    if not config["host"] or not config["from_addr"]:
        logger.info("SMTP not configured, skipping %s email", kind)
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = _prefixed_subject(subject)
    msg["From"] = config["from_addr"]
    msg["To"] = to_addr
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(config["host"], config["port"], timeout=10) as server:
            server.ehlo()
            if server.has_extn("starttls"):
                server.starttls()
                server.ehlo()
            if config["user"] and config["password"] and server.has_extn("auth"):
                server.login(config["user"], config["password"])
            server.send_message(msg)
        logger.info("%s email sent to %s", kind, to_addr)
        return True
    except Exception:
        logger.warning("Failed to send %s email", kind, exc_info=True)
        return False


def _email_shell(heading: str, body_html: str, footer_html: str = "") -> str:
    """Wrap email body in a minimal branded layout shared by user emails."""
    footer = (
        f'<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">'
        f'<p style="color:#6b7280;font-size:12px">{footer_html}</p>'
        if footer_html
        else ""
    )
    return f"""
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
                max-width:560px;margin:0 auto;color:#111827">
            <h2 style="color:#3b82f6;margin:0 0 16px">{heading}</h2>
      {body_html}
      {footer}
    </div>
    """


def send_suggestion_notification(suggestion, admin_email: str) -> None:
    """Send an email notification about a new event suggestion. Skips silently if SMTP not configured."""
    subject = f"New Event Suggestion: {escape(suggestion.title)}"
    html = f"""
    <h2>New Event Suggestion</h2>
    <p><strong>Title:</strong> {escape(suggestion.title)}</p>
    <p><strong>Date:</strong> {escape(str(suggestion.start))} — {escape(str(suggestion.end))}</p>
    <p><strong>Location:</strong> {escape(suggestion.location or "Not specified")}</p>
    <p><strong>Submitter:</strong> {escape(suggestion.submitter_name or "Anonymous")}
       ({escape(suggestion.submitter_email or "no email")})</p>
    <p><strong>Description:</strong><br>{escape(suggestion.description or "None")}</p>
    <hr>
    <p><em>Review this suggestion in your admin panel.</em></p>
    """
    _send_email(admin_email, subject, html, "suggestion notification")


def _send_admin_email(subject: str, html: str, admin_email: str, kind: str) -> None:
    _send_email(admin_email, subject, html, kind)


def send_promo_code_notification(
    promo, event_title: str, submitter_label: str, admin_email: str
) -> None:
    """Email the admin about a new (or re-edited) user-submitted promo code."""
    subject = f"New Promo Code: {escape(event_title)}"
    expires = str(promo.expires_at) if promo.expires_at else "No expiry"
    html = f"""
    <h2>New Promo Code Submission</h2>
    <p><strong>Event:</strong> {escape(event_title)}</p>
    <p><strong>Code:</strong> {escape(promo.code)}</p>
    <p><strong>Description:</strong> {escape(promo.description or "")}</p>
    <p><strong>Source URL:</strong> {escape(promo.source_url or "")}</p>
    <p><strong>Expires:</strong> {escape(expires)}</p>
    <p><strong>Submitter:</strong> {escape(submitter_label)}</p>
    <hr>
    <p><em>Review in the Promo Codes tab of your admin panel.</em></p>
    """
    _send_admin_email(subject, html, admin_email, "promo code notification")


def send_new_user_notification(user, admin_email: str) -> None:
    """Email the admin when a user account is created."""
    subject = f"New User Signup: {escape(user.email)}"
    handle = f"@{user.handle}" if user.handle else "Not set"
    created = str(user.created_at) if user.created_at else "Unknown"
    html = f"""
    <h2>New User Signup</h2>
    <p><strong>Name:</strong> {escape(user.display_name or user.email)}</p>
    <p><strong>Email:</strong> {escape(user.email)}</p>
    <p><strong>Handle:</strong> {escape(handle)}</p>
    <p><strong>Provider:</strong> {escape(user.provider)}</p>
    <p><strong>User ID:</strong> {escape(str(user.id))}</p>
    <p><strong>Created:</strong> {escape(created)}</p>
    <hr>
    <p><em>This email is sent once, when the user account is first created.</em></p>
    """
    _send_admin_email(subject, html, admin_email, "new user notification")


def send_organizer_claim_notification(
    claim, user_label: str, event_count: int, admin_email: str
) -> None:
    """Email the admin about a new organizer claim awaiting review."""
    subject = f"New Organizer Claim: {escape(user_label)}"
    html = f"""
    <h2>New Organizer Claim</h2>
    <p><strong>Applicant:</strong> {escape(user_label)}</p>
    <p><strong>Events claimed:</strong> {event_count}</p>
    <hr>
    <p><em>Review in the Organizer Claims tab of your admin panel.</em></p>
    """
    _send_admin_email(subject, html, admin_email, "organizer claim notification")


# --- User-facing re-engagement emails -------------------------------------


def _unsubscribe_footer(user_id, category: str, label: str) -> str:
    app = get_public_app_url()
    token = make_unsubscribe_token(str(user_id), category)
    unsub = f"{app}/unsubscribe?token={token}"
    # Anchor points at the specific per-feature toggle row so the user
    # lands on the exact cell governing what they just unsubscribed from.
    fragment = {
        "reminder": "notify-event-reminders",
        "social_activity": "notify-social-activity",
        "interest_matches": "notify-interest-matches",
        "activity": "notifications",
    }.get(category, "notifications")
    settings = f"{app}/account#{fragment}"
    return (
        f"You're receiving {label} from Movida. "
        f'<a href="{unsub}">Unsubscribe</a> · '
        f'<a href="{settings}">Notification settings</a>'
    )


def send_event_reminder_email(user, event, when_label: str) -> bool:
    """Email a user a reminder for an event they're going to.

    ``when_label`` is a human phrase like "tomorrow at 20:00" already
    formatted in the user's timezone by the caller.
    """
    if not user.email:
        return False
    app = get_public_app_url()
    event_url = f"{app}/event/{escape(str(event.event_id))}"
    title = escape(event.title or "your event")
    title_link = (
        f'<a href="{event_url}" style="color:#1d4ed8;text-decoration:none">{title}</a>'
    )
    location = escape(event.location or "")
    subject = f"Reminder: {event.title or 'your event'} is coming up"
    body = f"""
    <p>This is a reminder that you're going to:</p>
    <p style="font-size:18px;font-weight:600;margin:8px 0">{title_link}</p>
    <p style="color:#374151;margin:4px 0">🕒 {escape(when_label)}</p>
    {f'<p style="color:#374151;margin:4px 0">📍 {location}</p>' if location else ""}
    <p style="margin:20px 0">
      <a href="{event_url}"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        View event
      </a>
    </p>
    """
    footer = _unsubscribe_footer(user.id, "reminder", "event reminders")
    html = _email_shell("See you on the dance floor 💃", body, footer)
    return _send_email(user.email, subject, html, "event reminder")


def send_activity_digest_email(
    user,
    lines: list[str],
    *,
    feature: str = "social_activity",
) -> bool:
    """Email a user a batched digest of recent activity for one feature.

    ``lines`` are pre-rendered, already-escaped HTML snippets (one per
    notification) produced by the activity-email worker.

    ``feature`` is ``"social_activity"`` (default) or ``"interest_matches"``
    and controls the subject line, footer copy, and the per-feature
    unsubscribe token category so the footer link disables the right
    email channel.
    """
    if not user.email or not lines:
        return False
    app = get_public_app_url()
    count = len(lines)
    if feature == "interest_matches":
        subject = (
            "1 new event matched your saved search on Movida"
            if count == 1
            else f"{count} new events matched your saved searches on Movida"
        )
        heading = "New matches on Movida"
        footer_label = "interest match updates"
    else:
        subject = (
            "You have 1 new notification on Movida"
            if count == 1
            else f"You have {count} new notifications on Movida"
        )
        heading = "New activity on Movida"
        footer_label = "activity updates"
    items = "".join(
        f'<li style="margin:6px 0;color:#374151">{line}</li>' for line in lines
    )
    body = f"""
    <p>Here's what happened in your scene:</p>
    <ul style="padding-left:18px;margin:12px 0">{items}</ul>
    <p style="margin:20px 0">
      <a href="{app}/account#notifications"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        Open Movida
      </a>
    </p>
    """
    footer = _unsubscribe_footer(user.id, feature, footer_label)
    html = _email_shell(heading, body, footer)
    return _send_email(user.email, subject, html, f"activity digest ({feature})")
