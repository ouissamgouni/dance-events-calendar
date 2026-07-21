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


def _admin_panel_cta_html(label: str = "Open admin panel") -> str:
    """Primary CTA button linking to the admin panel, styled to match the
    buttons used in user-facing emails (e.g. "View event", "Open Movida")."""
    app = get_public_app_url()
    return f"""
    <p style="margin:20px 0">
      <a href="{app}/admin"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        {label}
      </a>
    </p>
    """


def _send_admin_email(subject: str, html: str, admin_email: str, kind: str) -> None:
    _send_email(admin_email, subject, html, kind)


def send_suggestion_notification(suggestion, admin_email: str) -> None:
    """Send an email notification about a new event suggestion. Skips silently if SMTP not configured."""
    subject = f"New Event Suggestion: {escape(suggestion.title)}"
    body = f"""
    <p><strong>Title:</strong> {escape(suggestion.title)}</p>
    <p><strong>Date:</strong> {escape(str(suggestion.start))} — {escape(str(suggestion.end))}</p>
    <p><strong>Location:</strong> {escape(suggestion.location or "Not specified")}</p>
    <p><strong>Submitter:</strong> {escape(suggestion.submitter_name or "Anonymous")}
       ({escape(suggestion.submitter_email or "no email")})</p>
    <p><strong>Description:</strong><br>{escape(suggestion.description or "None")}</p>
    {_admin_panel_cta_html("Review suggestion")}
    """
    html = _email_shell("New Event Suggestion", body)
    _send_admin_email(subject, html, admin_email, "suggestion notification")


def send_promo_code_notification(
    promo, event_title: str, submitter_label: str, admin_email: str
) -> None:
    """Email the admin about a new (or re-edited) user-submitted promo code."""
    subject = f"New Promo Code: {escape(event_title)}"
    expires = str(promo.expires_at) if promo.expires_at else "No expiry"
    body = f"""
    <p><strong>Event:</strong> {escape(event_title)}</p>
    <p><strong>Code:</strong> {escape(promo.code)}</p>
    <p><strong>Description:</strong> {escape(promo.description or "")}</p>
    <p><strong>Source URL:</strong> {escape(promo.source_url or "")}</p>
    <p><strong>Expires:</strong> {escape(expires)}</p>
    <p><strong>Submitter:</strong> {escape(submitter_label)}</p>
    {_admin_panel_cta_html("Review promo code")}
    """
    html = _email_shell("New Promo Code Submission", body)
    _send_admin_email(subject, html, admin_email, "promo code notification")


def send_new_user_notification(user, admin_email: str) -> None:
    """Email the admin when a user account is created."""
    subject = f"New User Signup: {escape(user.email)}"
    handle = f"@{user.handle}" if user.handle else "Not set"
    created = str(user.created_at) if user.created_at else "Unknown"
    body = f"""
    <p><strong>Name:</strong> {escape(user.display_name or user.email)}</p>
    <p><strong>Email:</strong> {escape(user.email)}</p>
    <p><strong>Handle:</strong> {escape(handle)}</p>
    <p><strong>Provider:</strong> {escape(user.provider)}</p>
    <p><strong>User ID:</strong> {escape(str(user.id))}</p>
    <p><strong>Created:</strong> {escape(created)}</p>
    {_admin_panel_cta_html("View user")}
    """
    footer = "This email is sent once, when the user account is first created."
    html = _email_shell("New User Signup", body, footer)
    _send_admin_email(subject, html, admin_email, "new user notification")


def send_organizer_claim_notification(
    claim, user_label: str, event_count: int, admin_email: str
) -> None:
    """Email the admin about a new organizer claim awaiting review."""
    subject = f"New Organizer Claim: {escape(user_label)}"
    body = f"""
    <p><strong>Applicant:</strong> {escape(user_label)}</p>
    <p><strong>Events claimed:</strong> {event_count}</p>
    {_admin_panel_cta_html("Review organizer claim")}
    """
    html = _email_shell("New Organizer Claim", body)
    _send_admin_email(subject, html, admin_email, "organizer claim notification")


# --- User-facing re-engagement emails -------------------------------------


def send_install_app_invitation_email(user) -> bool:
    """Email a user inviting them to install the Movida app.

    Sent on-demand by an admin (Admin → Users → "Send install email"), e.g.
    for a user who dismissed the in-app banner and hasn't installed yet.
    Not tied to any notification-preference category, so it carries no
    unsubscribe link — it's a one-off invitation, not a recurring
    subscription.
    """
    if not user.email:
        return False
    app = get_public_app_url()
    install_url = f"{app}/install"
    name = escape(user.display_name or "there")
    subject = "Install Movida for faster access and reminders"
    body = f"""
    <p>Hi {name},</p>
    <p>Install Movida on your phone or computer for the best experience:</p>
    <ul style="padding-left:18px;margin:12px 0;color:#374151">
      <li style="margin:6px 0">⚡ <strong>Faster access</strong> — opens straight from your home screen, no browser bar</li>
      <li style="margin:6px 0">🔔 <strong>Reminders</strong> — get notified about events you're going to, new events you might like and activity from friends</li>
      <li style="margin:6px 0">📱 <strong>App-like feel</strong> — full-screen, no need to keep a tab open</li>
    </ul>
    <p style="margin:20px 0">
      <a href="{install_url}"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        Install Movida
      </a>
    </p>
    <p style="color:#6b7280;font-size:13px">
      Button not doing anything on your device? Our
      <a href="{install_url}">install page</a> has step-by-step
      instructions for iPhone/iPad and Android.
    </p>
    <p style="color:#6b7280;font-size:13px">
      Once installed, open Movida from your Home Screen and allow
      notifications so you don't miss reminders and updates.
    </p>
    """
    html = _email_shell("Get the Movida app", body)
    return _send_email(user.email, subject, html, "install app invitation")


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
        "promo_codes": "notify-promo-codes",
        "activity": "notifications",
    }.get(category, "notifications")
    settings = f"{app}/account#{fragment}"
    return (
        f"You're receiving {label} from Movida. "
        f'<a href="{unsub}">Unsubscribe</a> · '
        f'<a href="{settings}">Notification settings</a>'
    )


def _icon_link_row(icon: str, label: str, href: str) -> str:
    """One small icon + text link, sized to sit inline next to the
    other CTAs in a single row (see ``_engagement_ctas_html``)."""
    app = get_public_app_url()
    return (
        f'<a href="{href}" style="color:#1d4ed8;text-decoration:none;'
        f'font-size:12px;white-space:nowrap">'
        f'<img src="{app}/{icon}" alt="" width="14" height="14" '
        f'style="vertical-align:middle;margin-right:4px">{label}'
        f"</a>"
    )


def _engagement_ctas_html(notifications_href: str) -> str:
    """Shared row of engagement links appended to every user email.

    All four CTAs ("Open Movida" plus the three icon links) render side
    by side in a single row via a table layout — the reliable way to
    get a horizontal row across email clients, since flexbox/inline-
    block support is inconsistent (e.g. Outlook). "Open Movida" is the
    primary button (opens the homepage); the rest are plain links (not
    buttons) with a leading icon, per product spec. ``notifications_href``
    varies by email (points at the relevant Settings section for that
    email's category).
    """
    app = get_public_app_url()
    return f"""
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 12px">
      <tr>
        <td style="padding-right:16px">
          <a href="{app}/"
                     style="background:#3b82f6;color:#fff;text-decoration:none;
                                    padding:10px 18px;display:inline-block;white-space:nowrap">
            <img src="{app}/open.png" alt="" width="16" height="16"
                 style="vertical-align:middle;margin-right:8px">Open Movida
          </a>
        </td>
        <td style="padding-right:16px">{_icon_link_row("share.png", "Invite a friend", f"{app}/invite")}</td>
        <td style="padding-right:16px">{_icon_link_row("save-pink.png", "Install Movida", f"{app}/install")}</td>
        <td>{_icon_link_row("setting.png", "Notifications Settings", notifications_href)}</td>
      </tr>
    </table>
    """


def _people_suggestions_html(suggestions: list[dict]) -> str:
    """ "People you may want to follow" section for the activity digest
    email — up to 5 rows sourced from the suggestion service, styled to
    mirror the in-app "People you may know" card: avatar, a mutual-
    friend/follower-count line, and a one-click Follow button/link
    (``?follow=1`` triggers an auto-follow on page load once signed in).
    """
    if not suggestions:
        return ""
    app = get_public_app_url()
    rows = []
    for s in suggestions[:5]:
        handle = escape(s["handle"])
        name = escape(s.get("display_name") or f"@{handle}")
        profile_url = f"{app}/u/{handle}"
        follow_url = f"{profile_url}?follow=1"
        avatar_url = s.get("avatar_url")
        mutual = s.get("mutual_friend_count") or 0
        followers = s.get("followers_count") or 0
        avatar_html = (
            f'<img src="{escape(avatar_url)}" alt="" width="40" height="40" '
            f'style="border-radius:50%;display:block;object-fit:cover">'
            if avatar_url
            else (
                '<div style="width:40px;height:40px;border-radius:50%;'
                'background:#e5e7eb"></div>'
            )
        )
        detail_bits = []
        if mutual > 0:
            detail_bits.append(
                f"Friend of {mutual} mutual friend{'s' if mutual != 1 else ''}"
            )
        detail_bits.append(f"{followers} follower{'s' if followers != 1 else ''}")
        detail = " &middot; ".join(detail_bits)
        rows.append(
            f"""
        <tr>
          <td style="padding:8px 10px 8px 0;width:40px">
            <a href="{profile_url}">{avatar_html}</a>
          </td>
          <td style="padding:8px 0">
            <a href="{profile_url}" style="color:#111827;text-decoration:none;font-weight:600;font-size:14px">{name}</a>
            <div style="color:#6b7280;font-size:12px">{detail}</div>
          </td>
          <td style="padding:8px 0 8px 10px;text-align:right;white-space:nowrap">
            <a href="{follow_url}"
                       style="background:#3b82f6;color:#fff;text-decoration:none;
                                      font-size:12px;padding:6px 14px;display:inline-block">
              Follow
            </a>
          </td>
        </tr>
        """
        )
    return f"""
    <div style="margin:20px 0">
      <h3 style="font-size:14px;color:#111827;margin:0 0 8px">People you may want to follow</h3>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">
        {"".join(rows)}
      </table>
    </div>
    """


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
    {_engagement_ctas_html(f"{app}/account#notifications")}
    """
    footer = _unsubscribe_footer(user.id, "reminder", "event reminders")
    html = _email_shell("See you on the dance floor 💃", body, footer)
    return _send_email(user.email, subject, html, "event reminder")


def send_promo_code_added_email(user, event, promo) -> bool:
    """Email a user that a saved event now has an approved promo code.

    Sent immediately on admin approval (not batched into the activity
    digest) since promo codes are often time-limited.
    """
    if not user.email:
        return False
    app = get_public_app_url()
    event_url = f"{app}/event/{escape(str(promo.event_id))}"
    title = escape(event.title if event else "your saved event")
    title_link = (
        f'<a href="{event_url}" style="color:#1d4ed8;text-decoration:none">{title}</a>'
    )
    expires = (
        f'<p style="color:#374151;margin:4px 0">Expires {escape(str(promo.expires_at))}</p>'
        if promo.expires_at
        else ""
    )
    description = (
        f'<p style="color:#374151;margin:4px 0">{escape(promo.description)}</p>'
        if promo.description
        else ""
    )
    subject = f"New promo code for {event.title if event else 'a saved event'}"
    body = f"""
    <p>A promo code was just approved for an event you saved:</p>
    <p style="font-size:18px;font-weight:600;margin:8px 0">{title_link}</p>
    <p style="font-size:16px;font-weight:600;margin:4px 0">Code: {escape(promo.code)}</p>
    {description}
    {expires}
    <p style="margin:20px 0">
      <a href="{event_url}"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        View event
      </a>
    </p>
    {_engagement_ctas_html(f"{app}/account#notify-promo-codes")}
    """
    footer = _unsubscribe_footer(user.id, "promo_codes", "promo code alerts")
    html = _email_shell("A promo code just dropped", body, footer)
    return _send_email(user.email, subject, html, "promo code added")


def send_activity_digest_email(
    user,
    lines: list[str],
    *,
    feature: str = "social_activity",
    discover_more_count: int = 0,
    suggestions: list[dict] | None = None,
) -> bool:
    """Email a user a batched digest of recent activity for one feature.

    ``lines`` are pre-rendered, already-escaped HTML snippets (one per
    notification) produced by the activity-email worker.

    ``feature`` is ``"social_activity"`` (default) or ``"interest_matches"``
    and controls the subject line, footer copy, the per-feature
    unsubscribe token category, and the Notifications Settings link target
    (social-activity digests point at the "Notifications & email" section;
    interest-match digests point at the "Search Profiles" section, since
    that's where alert profiles are managed).

    ``discover_more_count`` (interest-match digests only): number of
    additional matched events beyond ``lines`` that were collapsed behind
    a "Discover more" CTA linking to the "For you" page, per the admin's
    configured per-email cap (``interest_match_max_events_per_email``).

    ``suggestions`` (social-activity digests only): up to 5 people-you-
    may-want-to-follow rows (dicts with ``handle``/``display_name``/
    ``avatar_url``/``mutual_friend_count``/``followers_count``) from the
    friend-of-friend suggestion service.
    """
    if not user.email or not lines:
        return False
    app = get_public_app_url()
    count = len(lines) + discover_more_count
    if feature == "interest_matches":
        subject = (
            "1 new event matched your saved search on Movida"
            if count == 1
            else f"{count} new events matched your saved searches on Movida"
        )
        heading = "New matches on Movida"
        footer_label = "interest match updates"
        notifications_href = f"{app}/account#preferences"
    else:
        subject = (
            "You have 1 new notification on Movida"
            if count == 1
            else f"You have {count} new notifications on Movida"
        )
        heading = "New activity on Movida"
        footer_label = "activity updates"
        notifications_href = f"{app}/account#notifications"
    items = "".join(
        f'<li style="margin:6px 0;color:#374151">{line}</li>' for line in lines
    )
    discover_more_html = ""
    if feature == "interest_matches" and discover_more_count > 0:
        discover_more_html = f"""
    <p style="margin:12px 0">
      <a href="{app}/for-you"
                 style="color:#1d4ed8;text-decoration:underline">
        Discover {discover_more_count} more matching event{"s" if discover_more_count != 1 else ""} &rarr;
      </a>
    </p>
    """
    body = f"""
    <p>Here's what happened in your scene:</p>
    <ul style="padding-left:18px;margin:12px 0">{items}</ul>
    {discover_more_html}
    {_people_suggestions_html(suggestions or [])}
    {_engagement_ctas_html(notifications_href)}
    """
    footer = _unsubscribe_footer(user.id, feature, footer_label)
    html = _email_shell(heading, body, footer)
    return _send_email(user.email, subject, html, f"activity digest ({feature})")
