declare global {
    interface Window {
        umami?: {
            track: (
                event: string | { website?: string; url: string; referrer?: string },
                props?: Record<string, string | number>,
            ) => void;
        };
    }
}

let umamiLoaded = false;

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
        if (import.meta.env.DEV) {
            console.debug('[umami] VITE_UMAMI_WEBSITE_ID or VITE_UMAMI_URL not set — tracking calls will be logged only');
        }
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

/** Send a named custom event to Umami with optional properties. No-ops if not loaded. */
export function umamiTrack(event: string, props?: Record<string, string | number>): void {
    if (window.umami) {
        window.umami.track(event, props);
    } else if (import.meta.env.DEV) {
        console.debug('[umami] track', event, props);
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
    } else if (import.meta.env.DEV) {
        console.debug('[umami] pageview', window.location.pathname);
    }
}
