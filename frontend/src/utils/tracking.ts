import { trackEventView, trackEventSave, trackEventAttendance, trackLinkClick, trackExport, trackShare } from '../api';
import { getDeviceId } from './deviceId';
import { isAnalyticsDisabled, umamiTrack } from './umami';

/**
 * ── Analytics conventions ────────────────────────────────────────────────
 *
 * Event names: snake_case, past-tense `object_action` (e.g. `rating_submitted`).
 * Properties: low-cardinality primitives only — never PII (email, name, free
 * text comments, raw URLs with query strings) and never high-cardinality IDs
 * unless absolutely necessary.
 *
 * Two parallel pipelines:
 *   1. Server-side analytics rows (POSTs to /track/*) → power Admin
 *      Page analytics (most-viewed/saved/attended events, top links,
 *      source breakdown, exports). Joinable to event_id and user_id.
 *   2. Umami events → power product/UX funnel KPIs (signup conversion,
 *      rating modal open→submit funnel, etc). Anonymous, aggregate-only.
 *
 * Both are gated on the `analytics` consent category. Functional state
 * (saves, attendance) is persisted to the DB unconditionally — only the
 * analytics row + umami ping are consent-gated.
 */

/**
 * Read consent state directly from the cc_cookie written by vanilla-cookieconsent.
 * The cookie is written synchronously the moment the user accepts, so this is always
 * up-to-date regardless of CookieConsent module initialisation timing or HMR state.
 */
function readConsent(): { analytics: boolean; personalization: boolean } {
    // Admin sessions are excluded from analytics entirely so admin moderation
    // activity (page views, event clicks, saves, ratings) does not pollute
    // the product KPIs and ranking signals derived from these events.
    if (isAnalyticsDisabled()) {
        return { analytics: false, personalization: false };
    }
    try {
        const match = document.cookie.match(/(?:^|;\s*)cc_cookie=([^;]+)/);
        if (match) {
            const data = JSON.parse(decodeURIComponent(match[1]));
            if (Array.isArray(data.categories)) {
                return {
                    analytics: data.categories.includes('analytics'),
                    personalization: data.categories.includes('personalization'),
                };
            }
        }
    } catch { /* malformed cookie — fall through */ }
    return { analytics: false, personalization: false };
}

/** Returns the device ID only if personalization consent is granted. */
function getConsentedDeviceId(): string | undefined {
    return readConsent().personalization ? getDeviceId() : undefined;
}

/** Bucket comment length to keep Umami property cardinality low. */
function commentLengthBucket(len: number): string {
    if (len === 0) return '0';
    if (len <= 30) return '1-30';
    if (len <= 100) return '31-100';
    if (len <= 300) return '101-300';
    return '300+';
}

// ── Engagement (consent-gated; both DB row + Umami ping) ──────────────────

/** Track an event view. */
export function trackView(eventId: string, source?: string): void {
    if (!readConsent().analytics) return;
    trackEventView(eventId, getConsentedDeviceId(), source).catch(() => { });
    umamiTrack('event_viewed', { source: source ?? 'direct' });
}

/**
 * Persist a save/unsave. The DB row in user_saved_events is functional state
 * that powers "My Calendar" and share links — it must persist regardless of
 * cookie consent (legal basis: service the user explicitly requested). The
 * analytics log row (event_save) and umami ping are only written when
 * analytics consent is granted.
 */
export function trackSave(eventId: string, action: 'save' | 'unsave'): void {
    const analytics = readConsent().analytics;
    trackEventSave(eventId, getDeviceId(), action, analytics).catch(() => { });
    if (analytics) umamiTrack('event_saved', { action });
}

/** Track a link click. */
export function trackLink(eventId: string, url: string): void {
    if (!readConsent().analytics) return;
    trackLinkClick(eventId, url, getConsentedDeviceId()).catch(() => { });
    umamiTrack('link_clicked');
}

/** Track an export. */
export function trackExportAction(format: 'ics' | 'xlsx', eventCount: number): void {
    if (!readConsent().analytics) return;
    trackExport(format, eventCount, getConsentedDeviceId()).catch(() => { });
    umamiTrack('export_completed', { format, event_count: eventCount });
}

/** A share button was activated. The originator's share_code is read
 *  server-side from the auth session, so no need to send it here. */
export function trackShareAction(eventId: string): void {
    if (!readConsent().analytics) return;
    trackShare({
        eventId,
        action: 'share',
        deviceId: getConsentedDeviceId(),
    }).catch(() => { });
    umamiTrack('event_shared');
}

/** A referred visitor performed an attributable action (currently RSVP).
 *  ``shareCode`` comes from the URL captured by useReferralAttribution. */
export function trackShareConversion(eventId: string, shareCode: string): void {
    if (!readConsent().analytics) return;
    trackShare({
        eventId,
        action: 'conversion',
        shareCode,
        deviceId: getConsentedDeviceId(),
    }).catch(() => { });
    umamiTrack('share_converted');
}

/**
 * Persist a going / not-going toggle. Same rationale as trackSave: the DB
 * row is functional state, persisted unconditionally; analytics row + umami
 * ping are consent-gated.
 *
 * `sharePublicly` (only meaningful for "going") controls whether the
 * authenticated user appears in the public attendee list. Pass `undefined`
 * to leave the server's existing decision untouched (it falls back to the
 * user's `share_attendance_default`).
 */
export function trackAttendance(
    eventId: string,
    action: 'going' | 'not_going',
    sharePublicly?: boolean,
    isAuthenticated?: boolean,
): Promise<void> {
    const analytics = readConsent().analytics;
    if (analytics) {
        umamiTrack('attendance_marked', {
            action,
            share_publicly: sharePublicly === undefined ? 'unset' : String(sharePublicly),
            is_authenticated: isAuthenticated ?? false,
        });
    }
    return trackEventAttendance(eventId, getDeviceId(), action, analytics, sharePublicly)
        .then(() => { /* swallow result */ })
        .catch(() => { /* fire-and-forget on error */ });
}

// ── Auth funnel (Umami only — backend already records sessions) ──────────

export type AuthMethod = 'google' | 'dev';

export function trackSignupStarted(method: AuthMethod): void {
    if (!readConsent().analytics) return;
    umamiTrack('signup_started', { method });
}

export function trackSignupCompleted(method: AuthMethod): void {
    if (!readConsent().analytics) return;
    umamiTrack('signup_completed', { method });
}

export function trackLoginCompleted(method: AuthMethod): void {
    if (!readConsent().analytics) return;
    umamiTrack('login_completed', { method });
}

export function trackLoginFailed(method: AuthMethod, reason: string): void {
    if (!readConsent().analytics) return;
    umamiTrack('login_failed', { method, reason });
}

export function trackLogout(): void {
    if (!readConsent().analytics) return;
    umamiTrack('logout');
}

// ── Rating funnel (Umami only — DB rows live in event_ratings) ───────────

export type RatingEntryPoint = 'detail' | 'list' | 'map' | 'icon' | 'pill';

export function trackRatingModalOpened(entryPoint: RatingEntryPoint, isEdit: boolean): void {
    if (!readConsent().analytics) return;
    umamiTrack('rating_modal_opened', { entry_point: entryPoint, is_edit: isEdit });
}

export function trackRatingSubmitted(props: {
    stars: number;
    commentLength: number;
    tagCount: number;
    isAnonymous: boolean;
    isEdit: boolean;
}): void {
    if (!readConsent().analytics) return;
    umamiTrack('rating_submitted', {
        stars: props.stars,
        comment_length: commentLengthBucket(props.commentLength),
        tag_count: props.tagCount,
        is_anonymous: props.isAnonymous,
        is_edit: props.isEdit,
    });
}

export function trackRatingDeleted(): void {
    if (!readConsent().analytics) return;
    umamiTrack('rating_deleted');
}

export function trackRatingSubmitFailed(reason: string): void {
    if (!readConsent().analytics) return;
    umamiTrack('rating_submit_failed', { reason });
}
