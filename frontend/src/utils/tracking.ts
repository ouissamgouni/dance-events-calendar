import * as CookieConsent from 'vanilla-cookieconsent';
import { trackEventView, trackEventSave, trackLinkClick, trackExport } from '../api';
import { getDeviceId } from './deviceId';

/** Returns the device ID only if personalization consent is granted. */
function getConsentedDeviceId(): string | undefined {
    return CookieConsent.acceptedCategory('personalization') ? getDeviceId() : undefined;
}

/** Track an event view — requires analytics consent. */
export function trackView(eventId: string, source?: string): void {
    if (!CookieConsent.acceptedCategory('analytics')) return;
    trackEventView(eventId, getConsentedDeviceId(), source).catch(() => { });
}

/** Track an event save — requires analytics consent. */
export function trackSave(eventId: string, action: 'save' | 'unsave'): void {
    if (!CookieConsent.acceptedCategory('analytics')) return;
    const deviceId = getConsentedDeviceId();
    if (!deviceId) return; // save tracking requires device identification
    trackEventSave(eventId, deviceId, action).catch(() => { });
}

/** Track a link click — requires analytics consent. */
export function trackLink(eventId: string, url: string): void {
    if (!CookieConsent.acceptedCategory('analytics')) return;
    trackLinkClick(eventId, url, getConsentedDeviceId()).catch(() => { });
}

/** Track an export — requires analytics consent. */
export function trackExportAction(format: 'ics' | 'xlsx', eventCount: number): void {
    if (!CookieConsent.acceptedCategory('analytics')) return;
    trackExport(format, eventCount, getConsentedDeviceId()).catch(() => { });
}
