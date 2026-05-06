declare global {
    interface Window {
        umami?: {
            track: (
                event: string | { website?: string; url: string; referrer?: string },
                props?: Record<string, string | number | boolean>,
            ) => void;
            identify?: (data: Record<string, string | number | boolean>) => void;
        };
    }
}

let umamiLoaded = false;

/**
 * Module-level base context auto-merged into every `umamiTrack` call.
 * Keep it small (low-cardinality only): `is_authenticated`, `auth_method`.
 * Never put PII (email, name, user IDs) here.
 */
let baseContext: Record<string, string | number | boolean> = {};

export function setUmamiBaseContext(ctx: Record<string, string | number | boolean>): void {
    baseContext = { ...baseContext, ...ctx };
}

export function clearUmamiBaseContext(): void {
    baseContext = {};
}

/** Returns true when ?debug_analytics=1 is present in the URL — forces console logging. */
function isDebugMode(): boolean {
    try {
        return new URLSearchParams(window.location.search).get('debug_analytics') === '1';
    } catch {
        return false;
    }
}

/**
 * Dynamically injects the Umami script after analytics consent is granted.
 * Uses `data-auto-track="false"` so page views are fired manually (consent-gated).
 * No-ops silently when VITE_UMAMI_WEBSITE_ID or VITE_UMAMI_URL are not set
 * (e.g. CI, scenario environments) — tracking calls just become console.debug logs.
 */
export function loadUmami(): void {
    if (umamiLoaded) return;

    const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined;
    const umamiUrl = import.meta.env.VITE_UMAMI_URL as string | undefined;

    if (!websiteId || !umamiUrl) {
        // Warn in all environments so a missing build-time variable is visible in the
        // browser console even after a production deployment.
        console.warn('[umami] VITE_UMAMI_WEBSITE_ID or VITE_UMAMI_URL not set at build time — analytics disabled. Set these in the Cloudflare Pages dashboard (Environment variables).');
        return;
    }

    umamiLoaded = true;
    const script = document.createElement('script');
    script.defer = true;
    script.src = `${umamiUrl}/script.js`;
    script.dataset.websiteId = websiteId;
    script.dataset.autoTrack = 'false';
    // Fire the initial page view once the script has loaded and window.umami is available.
    // Without this, the page view effect in App.tsx runs before the script loads and is lost.
    script.addEventListener('load', () => umamiPageView());
    document.head.appendChild(script);
}

/**
 * Send a named custom event to Umami. Properties are merged with `baseContext`.
 *
 * Naming convention: snake_case, past-tense `object_action` (e.g. `rating_submitted`).
 * Properties: low-cardinality primitives only. Never include PII or free text.
 */
export function umamiTrack(event: string, props?: Record<string, string | number | boolean>): void {
    const merged = { ...baseContext, ...(props ?? {}) };
    if (isDebugMode() || (import.meta.env.DEV && !window.umami)) {
        console.debug('[umami] track', event, merged);
    }
    if (window.umami) {
        window.umami.track(event, merged);
    }
}

/** Send a page view for the current URL to Umami. No-ops if not loaded. */
export function umamiPageView(): void {
    if (window.umami) {
        const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined;
        window.umami.track({
            website: websiteId,
            url: window.location.pathname,
            referrer: document.referrer,
        });
    } else if (import.meta.env.DEV || isDebugMode()) {
        console.debug('[umami] pageview', window.location.pathname);
    }
}

/**
 * Associate the current Umami session with an internal user ID.
 * Pass only opaque IDs — never email, name, or third-party subjects.
 * Umami v2+ supports `window.umami.identify`; older builds will silently no-op.
 */
export function umamiIdentify(userId: string): void {
    if (isDebugMode() || (import.meta.env.DEV && !window.umami)) {
        console.debug('[umami] identify', userId);
    }
    if (window.umami?.identify) {
        window.umami.identify({ userId });
    }
}
