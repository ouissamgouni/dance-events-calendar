import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as CookieConsent from 'vanilla-cookieconsent';
import 'vanilla-cookieconsent/dist/cookieconsent.css';
import { cookieConsentConfig } from '../utils/cookieconsent-config';
import { loadUmami, setAnalyticsDisabled } from '../utils/umami';
import { fetchAppInfo } from '../api';

interface ConsentContextValue {
    analyticsConsent: boolean;
    personalizationConsent: boolean;
    /**
     * True once the cookie-consent modal is no longer blocking the page —
     * either because a returning visitor already has valid consent, or a
     * first-time visitor just answered it. While the initial modal is up,
     * vanilla-cookieconsent adds `overflow:hidden` to `<html>`
     * (`disable--interaction`), which triggers a known WebKit bug where
     * sibling `position:fixed` elements (like the install/push banners)
     * can render mispositioned/hidden and stay stuck that way even after
     * the lock is lifted, until a full reload repaints them. Other fixed
     * banners should gate on this flag so they never first render during
     * that window.
     */
    consentResolved: boolean;
    showPreferences: () => void;
}

const ConsentContext = createContext<ConsentContextValue>({
    analyticsConsent: false,
    personalizationConsent: false,
    consentResolved: false,
    showPreferences: () => { },
});

export function ConsentProvider({ children }: { children: ReactNode }) {
    const [analyticsConsent, setAnalyticsConsent] = useState(false);
    const [personalizationConsent, setPersonalizationConsent] = useState(false);
    const [consentResolved, setConsentResolved] = useState(false);
    // null = still loading server config; once resolved, true means the
    // backend reports analytics_enabled=true (or we couldn't tell — fail
    // open to preserve existing behavior).
    const serverAllowsAnalyticsRef = useRef<boolean | null>(null);

    const syncConsent = useCallback(() => {
        const analytics = CookieConsent.acceptedCategory('analytics');
        const personalization = CookieConsent.acceptedCategory('personalization');
        setAnalyticsConsent(analytics);
        setPersonalizationConsent(personalization);
        setConsentResolved(CookieConsent.validConsent());
        // Only load Umami once both: (a) user consented, and (b) the
        // backend confirmed analytics are enabled (or we haven't heard
        // back yet — fail open). When the backend later says disabled,
        // setAnalyticsDisabled(true) defensively wipes window.umami.
        if (analytics && serverAllowsAnalyticsRef.current !== false) {
            loadUmami();
        }
    }, []);

    useEffect(() => {
        // Fetch the server-side master switch in parallel with consent setup.
        // ANALYTICS_ENABLED=false on the backend → suppress Umami here.
        fetchAppInfo()
            .then((info) => {
                const allowed = info.analytics_enabled !== false;
                serverAllowsAnalyticsRef.current = allowed;
                if (!allowed) {
                    setAnalyticsDisabled(true);
                }
            })
            .catch(() => {
                // Network/backend failure: fail open (existing behavior).
                serverAllowsAnalyticsRef.current = true;
            });

        CookieConsent.run({
            ...cookieConsentConfig,
            onConsent: () => syncConsent(),
            onChange: () => syncConsent(),
        });
        // Sync initial state in case consent was already given
        syncConsent();
    }, [syncConsent]);

    const showPreferences = useCallback(() => {
        CookieConsent.showPreferences();
    }, []);

    return (
        <ConsentContext.Provider value={{ analyticsConsent, personalizationConsent, consentResolved, showPreferences }}>
            {children}
        </ConsentContext.Provider>
    );
}

export function useConsent() {
    return useContext(ConsentContext);
}
