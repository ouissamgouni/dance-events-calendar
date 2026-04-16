import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from backend.config.loader import get_smtp_config

logger = logging.getLogger(__name__)


def send_suggestion_notification(suggestion, admin_email: str) -> None:
    """Send an email notification about a new event suggestion. Skips silently if SMTP not configured."""
    config = get_smtp_config()
    if not config["host"] or not config["from_addr"]:
        logger.info("SMTP not configured, skipping suggestion notification email")
        return

    subject = f"New Event Suggestion: {suggestion.title}"
    html = f"""
    <h2>New Event Suggestion</h2>
    <p><strong>Title:</strong> {suggestion.title}</p>
    <p><strong>Date:</strong> {suggestion.start} — {suggestion.end}</p>
    <p><strong>Location:</strong> {suggestion.location or "Not specified"}</p>
    <p><strong>Submitter:</strong> {suggestion.submitter_name or "Anonymous"}
       ({suggestion.submitter_email or "no email"})</p>
    <p><strong>Description:</strong><br>{suggestion.description or "None"}</p>
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
