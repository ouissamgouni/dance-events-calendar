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
    showPreferences: () => void;
}

const ConsentContext = createContext<ConsentContextValue>({
    analyticsConsent: false,
    personalizationConsent: false,
    showPreferences: () => { },
});

export function ConsentProvider({ children }: { children: ReactNode }) {
    const [analyticsConsent, setAnalyticsConsent] = useState(false);
    const [personalizationConsent, setPersonalizationConsent] = useState(false);
    // null = still loading server config; once resolved, true means the
    // backend reports analytics_enabled=true (or we couldn't tell — fail
    // open to preserve existing behavior).
    const serverAllowsAnalyticsRef = useRef<boolean | null>(null);

    const syncConsent = useCallback(() => {
        const analytics = CookieConsent.acceptedCategory('analytics');
        const personalization = CookieConsent.acceptedCategory('personalization');
        setAnalyticsConsent(analytics);
        setPersonalizationConsent(personalization);
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
        <ConsentContext.Provider value={{ analyticsConsent, personalizationConsent, showPreferences }}>
            {children}
        </ConsentContext.Provider>
    );
}

export function useConsent() {
    return useContext(ConsentContext);
}
