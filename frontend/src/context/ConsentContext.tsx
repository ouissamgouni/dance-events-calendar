import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import * as CookieConsent from 'vanilla-cookieconsent';
import 'vanilla-cookieconsent/dist/cookieconsent.css';
import { cookieConsentConfig } from '../utils/cookieconsent-config';

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

    const syncConsent = useCallback(() => {
        setAnalyticsConsent(CookieConsent.acceptedCategory('analytics'));
        setPersonalizationConsent(CookieConsent.acceptedCategory('personalization'));
    }, []);

    useEffect(() => {
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
