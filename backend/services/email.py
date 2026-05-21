import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape

from backend.config.loader import get_smtp_config

logger = logging.getLogger(__name__)


def send_suggestion_notification(suggestion, admin_email: str) -> None:
    """Send an email notification about a new event suggestion. Skips silently if SMTP not configured."""
    config = get_smtp_config()
    if not config["host"] or not config["from_addr"]:
        logger.info("SMTP not configured, skipping suggestion notification email")
        return

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

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = config["from_addr"]
    msg["To"] = admin_email
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(config["host"], config["port"], timeout=10) as server:
            server.starttls()
            if config["user"] and config["password"]:
                server.login(config["user"], config["password"])
            server.send_message(msg)
        logger.info("Suggestion notification email sent to %s", admin_email)
    except Exception:
        logger.warning("Failed to send suggestion notification email", exc_info=True)


def _send_admin_email(subject: str, html: str, admin_email: str, kind: str) -> None:
    config = get_smtp_config()
    if not config["host"] or not config["from_addr"]:
        logger.info("SMTP not configured, skipping %s email", kind)
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = config["from_addr"]
    msg["To"] = admin_email
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(config["host"], config["port"], timeout=10) as server:
            server.starttls()
            if config["user"] and config["password"]:
                server.login(config["user"], config["password"])
            server.send_message(msg)
        logger.info("%s email sent to %s", kind, admin_email)
    except Exception:
        logger.warning("Failed to send %s email", kind, exc_info=True)


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
