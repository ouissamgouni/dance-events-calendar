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


def send_login_code_email(to_addr: str, code: str) -> bool:
    """Email a one-time sign-in code. Returns True if dispatched.

    Carries no unsubscribe link — it is a transactional security email, not a
    subscription. The code is displayed prominently and expires in 10 minutes.
    """
    if not to_addr:
        return False
    subject = f"Your {APP_NAME} sign-in code: {escape(code)}"
    body = f"""
    <p>Use this code to sign in to {APP_NAME}:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:6px;
              font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
              color:#111827;margin:20px 0">{escape(code)}</p>
    <p style="color:#6b7280;font-size:13px">
      This code expires in 10 minutes. If you didn't request it, you can safely
      ignore this email.
    </p>
    """
    html = _email_shell("Sign in to Movida", body)
    return _send_email(to_addr, subject, html, "login code")


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
        "review_prompt": "notify-review-prompt",
        "milestone": "notify-milestone-unlocked",
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
        <td>{_icon_link_row("setting.png", "Settings", notifications_href)}</td>
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


def send_event_reminder_email(
    user, event, when_label: str, include_ask_cta: bool = False
) -> bool:
    """Email a user a reminder for an event they're going to.

    ``when_label`` is a human phrase like "tomorrow at 20:00" already
    formatted in the user's timezone by the caller. When ``include_ask_cta``
    is True (popular events, see reminder_service), an "Ask a question" link
    to the event's message board is appended below the primary button.
    """
    if not user.email:
        return False
    app = get_public_app_url()
    event_url = f"{app}/event/{escape(str(event.event_id))}"
    ask_url = f"{event_url}/ask"
    title = escape(event.title or "your event")
    title_link = (
        f'<a href="{event_url}" style="color:#1d4ed8;text-decoration:none">{title}</a>'
    )
    location = escape(event.location or "")
    subject = f"Reminder: {event.title or 'your event'} is coming up"
    ask_cta = (
        f"""
    <p style="margin:4px 0 20px">
      <a href="{ask_url}" style="color:#1d4ed8;text-decoration:none;font-size:13px">
        💬 Ask a question about this event
      </a>
    </p>
    """
        if include_ask_cta
        else ""
    )
    body = f"""
    <p>This is a reminder that you're going to:</p>
    <p style="font-size:18px;font-weight:600;margin:8px 0">{title_link}</p>
    <p style="color:#374151;margin:4px 0">🕒 {escape(when_label)}</p>
    {f'<p style="color:#374151;margin:4px 0">📍 {location}</p>' if location else ""}
    <p style="margin:20px 0 4px">
      <a href="{event_url}"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        View event
      </a>
    </p>
    {ask_cta}
    {_engagement_ctas_html(f"{app}/account#notifications")}
    """
    footer = _unsubscribe_footer(user.id, "reminder", "event reminders")
    html = _email_shell("See you on the dance floor 💃", body, footer)
    return _send_email(user.email, subject, html, "event reminder")


def send_event_review_prompt_email(user, event, friend_proof=None) -> bool:
    """Email a user a nudge to rate an event they went to, some hours after
    it ended (see ``services/review_prompt_service.py``).

    ``friend_proof`` is an optional pre-formatted names phrase (e.g. "Laura
    and Marc" or "Laura, Marc +3 others"); when present the copy switches to
    the friends' social-proof variant ("… shared their experience — share
    yours") instead of the generic nudge.
    """
    if not user.email:
        return False
    app = get_public_app_url()
    event_url = f"{app}/event/{escape(str(event.event_id))}/review"
    title = escape(event.title or "the event")
    title_link = (
        f'<a href="{event_url}" style="color:#1d4ed8;text-decoration:none">{title}</a>'
    )
    if friend_proof:
        who = escape(friend_proof)
        subject = f"{friend_proof} shared their experience at {event.title or 'your event'} — share yours"
        heading = "Your friends shared their experience 💃"
        lede = f"<p><strong>{who}</strong> shared their experience of:</p>"
        tagline = "Add yours to help others discover great nights out."
    else:
        subject = f"How was {event.title or 'your event'}?"
        heading = "How was your night? 💃"
        lede = "<p>You went to:</p>"
        tagline = "Share a quick rating to help others discover great nights out."
    body = f"""
    {lede}
    <p style="font-size:18px;font-weight:600;margin:8px 0">{title_link}</p>
    <p style="color:#374151;margin:4px 0">{tagline}</p>
    <p style="margin:20px 0">
      <a href="{event_url}"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        Share your experience
      </a>
    </p>
    {_engagement_ctas_html(f"{app}/account#notifications")}
    """
    footer = _unsubscribe_footer(user.id, "review_prompt", "review prompts")
    html = _email_shell(heading, body, footer)
    return _send_email(user.email, subject, html, "review prompt")


def send_milestone_instant_email(user, milestones) -> bool:
    """Email a user that they unlocked one or more Dance Passport milestones
    (see ``services/milestone_notification_service.py``). ``milestones`` is a
    non-empty list of ``passport.Milestone``; multiple unlocked in the same
    dispatch pass are combined into a single email instead of one per milestone.

    Rendered with the shared card builder (:func:`_render_card`) so the instant
    milestone email matches the combined digest's milestone cards.
    """
    if not user.email or not milestones:
        return False
    app = get_public_app_url()
    passport_url = f"{app}/mine/passport"
    cards = []
    for m in milestones:
        primary = (
            f'You unlocked <a href="{passport_url}" '
            f'style="color:#1d4ed8;text-decoration:underline">'
            f"<strong>{escape(m.name)}</strong></a>"
        )
        if m.description:
            primary += f" \u2014 {escape(m.description)}"
        cards.append(
            _render_card({"kind": "milestone_unlocked", "primary_html": primary})
        )
    if len(milestones) == 1:
        subject = f"Milestone unlocked: {milestones[0].name}"
        heading = "New milestone unlocked \U0001f389"
        intro = "You just unlocked a new Dance Passport milestone:"
    else:
        subject = f"You unlocked {len(milestones)} milestones! \U0001f389"
        heading = "New milestones unlocked \U0001f389"
        intro = "You just unlocked new Dance Passport milestones:"
    body = f"""
    <p>{intro}</p>
    {"".join(cards)}
    <p style="margin:20px 0">
      <a href="{passport_url}"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        View your passport
      </a>
    </p>
    {_engagement_ctas_html(f"{app}/account#notify-milestone-unlocked")}
    """
    footer = _unsubscribe_footer(user.id, "milestone", "achievement updates")
    html = _email_shell(heading, body, footer)
    return _send_email(user.email, subject, html, "milestone unlocked")


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


def event_message_action_phrase(kind: str, category: str | None) -> str:
    """Verb phrase for an event-message notification, e.g. "asked a question
    about". Shared by the activity-email renderer and the instant email so the
    subject/line copy stays in sync. ``category`` (the notification
    ``context``) shapes top-level posts; replies use a fixed phrase, except
    the thread's root author sees "your message" (signalled by
    ``category == "root"``).
    """
    if kind == "event_message_reply":
        return (
            "replied to your message on"
            if category == "root"
            else "replied to a message on"
        )
    return {
        "question": "asked a question about",
        "accommodation": "posted about accommodation for",
        "roommate": "posted about accommodation for",  # legacy alias
        "ride": "posted about a ride for",
        "tickets": "posted about tickets for",
        "meetup": "posted a meetup for",
        "lost_found": "posted a lost-and-found note for",
    }.get((category or "other").lower(), "posted a message on")


def send_event_message_instant_email(
    user, actor, event, kind: str, category: str | None, snippet: str | None
) -> bool:
    """Email a user immediately about a new event-message post/reply when the
    admin has enabled instant delivery for event messages (instead of waiting
    for the activity digest scheduler).

    The subject is content-aware: "{Actor} {action} {Event}" (e.g. "Ana asked
    a question about Salsa Social") rather than the generic digest subject.
    """
    if not user.email:
        return False
    actor_name = "Someone"
    if actor is not None:
        actor_name = (
            getattr(actor, "display_name", None)
            or (f"@{actor.handle}" if getattr(actor, "handle", None) else None)
            or "Someone"
        )
    action = event_message_action_phrase(kind, category)
    event_title = event.title if event and event.title else "an event"
    subject = f"{actor_name} {action} {event_title}"
    app = get_public_app_url()
    event_url = f"{app}/event/{escape(str(event.event_id))}#messages"
    title_link = (
        f'<a href="{event_url}" style="color:#1d4ed8;text-decoration:none">'
        f"{escape(event_title)}</a>"
    )
    snippet_html = (
        f'<p style="color:#374151;margin:8px 0;font-style:italic">'
        f"\u201c{escape(snippet)}\u201d</p>"
        if snippet
        else ""
    )
    heading = "New message" if kind == "event_message_reply" else "New activity"
    body = f"""
    <p>{escape(actor_name)} {escape(action)} {title_link}:</p>
    {snippet_html}
    <p style="margin:20px 0">
      <a href="{event_url}"
                 style="background:#3b82f6;color:#fff;text-decoration:none;
                                padding:10px 18px;display:inline-block">
        View the conversation
      </a>
    </p>
    {_engagement_ctas_html(f"{app}/account#notifications")}
    """
    footer = _unsubscribe_footer(user.id, "event_messages", "event message updates")
    html = _email_shell(f"{heading} on {APP_NAME}", body, footer)
    return _send_email(user.email, subject, html, "event message instant")


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
        footer_category = feature
        notifications_href = f"{app}/account#preferences"
    elif feature == "milestone_unlocked":
        subject = (
            "You unlocked a new milestone on Movida"
            if count == 1
            else f"You unlocked {count} new milestones on Movida"
        )
        heading = "New milestone unlocked \U0001f389"
        footer_label = "achievement updates"
        footer_category = "milestone"
        notifications_href = f"{app}/account#notify-milestone-unlocked"
    else:
        subject = (
            "You have 1 new notification on Movida"
            if count == 1
            else f"You have {count} new notifications on Movida"
        )
        heading = "New activity on Movida"
        footer_label = "activity updates"
        footer_category = feature
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
    footer = _unsubscribe_footer(user.id, footer_category, footer_label)
    html = _email_shell(heading, body, footer)
    return _send_email(user.email, subject, html, f"activity digest ({feature})")


# --- Combined activity digest (v2) -----------------------------------------
#
# The v2 digest merges every eligible feature section into a single
# card-styled email per recipient (behind the ``digest_v2_enabled`` site
# setting). Cards carry an avatar (person kinds) or a type tile (event /
# milestone kinds), the same linked primary sentence used by the legacy
# list digest, and a muted "date · city" subline. Per-section headings and
# a "See all" CTA replace the flat bulleted list.

_CARD_PERSON_KINDS = frozenset(
    {
        "subscription_going",
        "subscription_review",
        "subscription_milestone",
        "subscription_suggested",
        "new_follower",
        "new_friend",
        "follow_request",
        "follow_request_approved",
        "event_message",
        "event_message_reply",
    }
)

# Card tile glyph per non-person kind. milestone_unlocked uses a medal so the
# tile doesn't duplicate the 🎉 that already opens its notification sentence.
_CARD_KIND_EMOJI = {
    "milestone_unlocked": "\U0001f3c5",
    "interest_event": "\U0001f50e",
    "event_reminder": "\u23f0",
}

# (heading, CTA path) per feature section. A ``None`` path renders no CTA.
_SECTION_META: dict[str, tuple[str, str | None]] = {
    "friends_going": ("Friends going out", "/notifications"),
    "friend_reviews": ("Reviews from people you follow", "/notifications"),
    "friend_milestones": ("Milestones from people you follow", "/notifications"),
    "social_activity": ("Your social activity", "/notifications"),
    "interest_matches": ("New matches for your saved searches", "/for-you"),
    "milestone_unlocked": ("Your achievements", "/mine/passport"),
    "suggested_events": ("Suggested events", "/notifications"),
}


def _card_avatar_html(entry: dict) -> str:
    kind = entry.get("kind")
    is_person = kind in _CARD_PERSON_KINDS and not entry.get("anon")
    if is_person:
        url = entry.get("avatar_url")
        if url:
            return (
                f'<img src="{escape(url)}" alt="" width="40" height="40" '
                f'style="border-radius:50%;display:block;object-fit:cover">'
            )
        initial = escape((entry.get("initial") or "?")[:1].upper())
        return (
            '<div style="width:40px;height:40px;border-radius:50%;background:#e5e7eb;'
            "color:#374151;font-weight:600;text-align:center;line-height:40px;"
            f'font-size:16px">{initial}</div>'
        )
    emoji = _CARD_KIND_EMOJI.get(kind or "", "\U0001f4ec")
    return (
        '<div style="width:40px;height:40px;background:#eff6ff;font-size:20px;'
        f'text-align:center;line-height:40px">{emoji}</div>'
    )


def _render_card(entry: dict) -> str:
    """Render one structured digest entry as an HTML card.

    ``entry`` keys: ``kind``, ``primary_html`` (the already-escaped linked
    sentence from ``activity_email._render_line``), optional ``avatar_url``,
    ``initial`` (fallback avatar letter), ``subline`` ("date · city"), and
    ``anon`` (mask the avatar for anonymous reviews).
    """
    avatar = _card_avatar_html(entry)
    subline = entry.get("subline")
    subline_html = (
        f'<div style="color:#6b7280;font-size:12px;margin-top:2px">{escape(subline)}</div>'
        if subline
        else ""
    )
    return f"""
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0">
      <tr>
        <td style="width:40px;vertical-align:top;padding-right:10px">{avatar}</td>
        <td style="vertical-align:top">
          <div style="color:#111827;font-size:14px;line-height:1.4">{entry.get("primary_html", "")}</div>
          {subline_html}
        </td>
      </tr>
    </table>
    """


def _balance_sections(
    sections: list[dict], *, per_kind_cap: int, max_items: int
) -> list[dict]:
    """Cap per kind, round-robin trim to ``max_items``, track "and N more".

    Returns a list of ``{"feature", "buckets": {kind: {"entries", "more"}}}``
    for non-empty sections, with each bucket already capped and its ``more``
    overflow count set. Balancing keeps newest entries first and drops the
    oldest tail across kinds evenly so no single kind crowds out the rest.
    """
    from datetime import datetime as _dt

    section_data: list[dict] = []
    for sec in sections:
        buckets: dict[str, dict] = {}
        ordered = sorted(
            sec.get("entries", []),
            key=lambda e: e.get("created_at") or _dt.min,
            reverse=True,
        )
        for e in ordered:
            b = buckets.setdefault(e["kind"], {"entries": [], "more": 0})
            if len(b["entries"]) < max(1, per_kind_cap):
                b["entries"].append(e)
            else:
                b["more"] += 1
        if buckets:
            section_data.append({"feature": sec["feature"], "buckets": buckets})

    bucket_list = [b for s in section_data for b in s["buckets"].values()]
    total = sum(len(b["entries"]) for b in bucket_list)
    drop = total - max(1, max_items)
    idx = 0
    while drop > 0 and bucket_list:
        b = bucket_list[idx % len(bucket_list)]
        if b["entries"]:
            b["entries"].pop()
            b["more"] += 1
            drop -= 1
            idx += 1
        else:
            bucket_list.pop(idx % len(bucket_list))
    return section_data


def send_activity_digest_v2_email(
    user,
    sections: list[dict],
    *,
    per_kind_cap: int = 5,
    max_items: int = 20,
    suggestions: list[dict] | None = None,
) -> bool:
    """Send the combined, balanced, card-styled activity digest (v2).

    ``sections`` is a list of ``{"feature": str, "entries": [entry, ...]}``
    already gated upstream (per-feature digest flag, in-app channel flag,
    schedule slot, and the master ``digest_email_enabled`` opt-out). Each
    ``entry`` is the dict consumed by :func:`_render_card`. Returns ``True``
    when an email was dispatched.
    """
    if not user.email:
        return False
    section_data = _balance_sections(
        sections, per_kind_cap=per_kind_cap, max_items=max_items
    )
    app = get_public_app_url()
    blocks: list[str] = []
    card_count = 0
    for s in section_data:
        cards: list[str] = []
        for kind, b in s["buckets"].items():
            for e in b["entries"]:
                cards.append(_render_card(e))
                card_count += 1
            if b["more"] > 0:
                cards.append(
                    '<div style="color:#6b7280;font-size:12px;margin:0 0 8px 50px">'
                    f"and {b['more']} more</div>"
                )
        if not cards:
            continue
        label, href = _SECTION_META.get(
            s["feature"], ("Recent activity", "/notifications")
        )
        cta = (
            f'<a href="{app}{href}" style="color:#1d4ed8;text-decoration:underline;'
            f'font-size:12px">See all &rarr;</a>'
            if href
            else ""
        )
        blocks.append(
            f"""
    <div style="margin:20px 0 8px">
      <h3 style="font-size:14px;color:#111827;margin:0 0 4px">{escape(label)}</h3>
      {"".join(cards)}
      {cta}
    </div>
    """
        )
    if not blocks:
        return False
    subject = (
        "You have 1 new notification on Movida"
        if card_count == 1
        else f"You have {card_count} new notifications on Movida"
    )
    body = f"""
    <p>Here's what happened in your scene:</p>
    {"".join(blocks)}
    {_people_suggestions_html(suggestions or [])}
    {_engagement_ctas_html(f"{app}/account#notifications")}
    """
    footer = _unsubscribe_footer(user.id, "digest", "the activity digest")
    html = _email_shell("New activity on Movida", body, footer)
    return _send_email(user.email, subject, html, "activity digest (combined)")
