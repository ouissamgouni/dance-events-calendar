import { trackEventView, trackEventSave, trackEventAttendance, trackLinkClick, trackExport } from '../api';
import { getDeviceId } from './deviceId';
import { umamiTrack } from './umami';

/**
 * Read consent state directly from the cc_cookie written by vanilla-cookieconsent.
 * The cookie is written synchronously the moment the user accepts, so this is always
 * up-to-date regardless of CookieConsent module initialisation timing or HMR state.
 */
function readConsent(): { analytics: boolean; personalization: boolean } {
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

/** Track an event view — requires analytics consent. */
export function trackView(eventId: string, source?: string): void {
    if (!readConsent().analytics) return;
    trackEventView(eventId, getConsentedDeviceId(), source).catch(() => { });
    umamiTrack('event-view', { source: source ?? 'direct' });
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
    if (analytics) umamiTrack('event-save', { action });
}

/** Track a link click — requires analytics consent. */
export function trackLink(eventId: string, url: string): void {
    if (!readConsent().analytics) return;
    trackLinkClick(eventId, url, getConsentedDeviceId()).catch(() => { });
    umamiTrack('link-click');
}

/** Track an export — requires analytics consent. */
export function trackExportAction(format: 'ics' | 'xlsx', eventCount: number): void {
    if (!readConsent().analytics) return;
    trackExport(format, eventCount, getConsentedDeviceId()).catch(() => { });
    umamiTrack('export', { format, event_count: eventCount });
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
): Promise<void> {
    const analytics = readConsent().analytics;
    if (analytics) umamiTrack('event-attendance', { action });
    return trackEventAttendance(eventId, getDeviceId(), action, analytics, sharePublicly)
        .then(() => { /* swallow result */ })
        .catch(() => { /* fire-and-forget on error */ });
}
