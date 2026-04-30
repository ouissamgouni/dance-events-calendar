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

/** Track an event save — requires analytics consent. */
export function trackSave(eventId: string, action: 'save' | 'unsave'): void {
    if (!readConsent().analytics) return;
    const deviceId = getConsentedDeviceId();
    if (!deviceId) return; // save tracking requires device identification
    trackEventSave(eventId, deviceId, action).catch(() => { });
    umamiTrack('event-save', { action });
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

/** Track an event attendance toggle — requires analytics consent + device identification. */
export function trackAttendance(eventId: string, action: 'going' | 'not_going'): void {
    if (!readConsent().analytics) return;
    const deviceId = getConsentedDeviceId();
    if (!deviceId) return;
    trackEventAttendance(eventId, deviceId, action).catch(() => { });
    umamiTrack('event-attendance', { action });
}
