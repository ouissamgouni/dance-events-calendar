import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Shared "Install app" state.
 *
 * `beforeinstallprompt` (Chromium) is a single-use, app-wide browser event —
 * only the first listener to call `preventDefault()` gets to replay it later.
 * Capturing it once here lets both the bottom banner ({@link InstallPrompt})
 * and the persistent Settings-page entry trigger the same native install
 * flow, instead of each needing its own listener.
 *
 * iOS Safari never fires `beforeinstallprompt`, so `canInstall` simply stays
 * false there — install still happens via the share-sheet, outside our
 * control.
 */
interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function detectIos(): boolean {
    return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Social apps' embedded webviews can't install PWAs on any platform.
function detectInAppBrowser(userAgent: string = navigator.userAgent): boolean {
    return /Instagram|FBAN|FBAV|FB_IAB|BytedanceWebview|musical_ly|TikTok|LinkedInApp|Snapchat|Line\//i.test(userAgent);
}

export interface InstallInvitation {
    source: 'program';
    eventId: string;
    eventTitle: string;
}

interface PwaInstallContextValue {
    /** True once the browser has offered install and we haven't consumed it yet. */
    canInstall: boolean;
    /** True when already running as an installed PWA. */
    isStandalone: boolean;
    /** iPhone/iPad browsers need manual Add to Home Screen guidance. */
    isIos: boolean;
    /** Instagram/Facebook/TikTok-style webviews: user must open a real browser first. */
    isInAppBrowser: boolean;
    /** Optional high-intent context for the otherwise global install prompt. */
    invitation: InstallInvitation | null;
    requestInstallInvitation: (invitation: InstallInvitation) => void;
    clearInstallInvitation: () => void;
    /** Replays the deferred native prompt. Resolves to the outcome, or null if unavailable. */
    promptInstall: () => Promise<'accepted' | 'dismissed' | null>;
}

const PwaInstallContext = createContext<PwaInstallContextValue>({
    canInstall: false,
    isStandalone: false,
    isIos: false,
    isInAppBrowser: false,
    invitation: null,
    requestInstallInvitation: () => { },
    clearInstallInvitation: () => { },
    promptInstall: async () => null,
});

export function PwaInstallProvider({ children }: { children: ReactNode }) {
    const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
    const [invitation, setInvitation] = useState<InstallInvitation | null>(null);
    const [isIos] = useState(detectIos);
    const [isInAppBrowser] = useState(() => detectInAppBrowser());
    // Lazy-initialized (not set in an effect) so the very first render
    // already reflects reality — an effect-based initial value is briefly
    // wrong (defaults to `false`) which previously let the install banner
    // flash for an instant on every load for users already running the
    // installed app.
    const [isStandalone, setIsStandalone] = useState(
        () => window.matchMedia('(display-mode: standalone)').matches,
    );

    useEffect(() => {
        const onPrompt = (e: Event) => {
            e.preventDefault();
            setDeferred(e as BeforeInstallPromptEvent);
        };
        const onInstalled = () => {
            setDeferred(null);
            setIsStandalone(true);
        };
        window.addEventListener('beforeinstallprompt', onPrompt);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('beforeinstallprompt', onPrompt);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const promptInstall = useCallback(async () => {
        if (!deferred) return null;
        await deferred.prompt();
        const { outcome } = await deferred.userChoice;
        // Single-use per spec — Chrome fires a fresh beforeinstallprompt next
        // session if the user didn't install, so just drop our reference.
        setDeferred(null);
        return outcome;
    }, [deferred]);

    const requestInstallInvitation = useCallback((next: InstallInvitation) => {
        setInvitation(next);
    }, []);

    const clearInstallInvitation = useCallback(() => {
        setInvitation(null);
    }, []);

    return (
        <PwaInstallContext.Provider value={{
            canInstall: !!deferred,
            isStandalone,
            isIos,
            isInAppBrowser,
            invitation,
            requestInstallInvitation,
            clearInstallInvitation,
            promptInstall,
        }}>
            {children}
        </PwaInstallContext.Provider>
    );
}

export function usePwaInstall() {
    return useContext(PwaInstallContext);
}
