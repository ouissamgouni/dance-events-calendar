/**
 * Module-level consent state store.
 *
 * This store is the single source of truth for consent state used by tracking.ts.
 * It is:
 *  - Pre-seeded synchronously from the cc_cookie on module load (covers page reloads
 *    with stored consent, before the async CookieConsent.run() finishes).
 *  - Updated via setConsentState() whenever ConsentContext fires onConsent / onChange.
 *
 * Using this store instead of calling CookieConsent.acceptedCategory() directly in
 * tracking.ts avoids any potential timing/module-state issues with the async
 * CookieConsent initialisation.
 */

let _analyticsConsent = false;
let _personalizationConsent = false;

// Seed from the stored cc_cookie immediately so subsequent-visit tracking works
// even before the async CookieConsent.run() callback fires.
(function seedFromCookie() {
    try {
        const match = document.cookie.match(/(?:^|;\s*)cc_cookie=([^;]+)/);
        if (match) {
            const data = JSON.parse(decodeURIComponent(match[1]));
            if (Array.isArray(data.categories)) {
                _analyticsConsent = data.categories.includes('analytics');
                _personalizationConsent = data.categories.includes('personalization');
            }
        }
    } catch {
        // Silently ignore malformed cookie — defaults stay false.
    }
})();

/** Called by ConsentContext whenever consent is accepted or changed. */
export function setConsentState(analytics: boolean, personalization: boolean): void {
    _analyticsConsent = analytics;
    _personalizationConsent = personalization;
}

export function hasAnalyticsConsent(): boolean {
    return _analyticsConsent;
}

export function hasPersonalizationConsent(): boolean {
    return _personalizationConsent;
}
