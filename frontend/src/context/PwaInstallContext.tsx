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

interface PwaInstallContextValue {
    /** True once the browser has offered install and we haven't consumed it yet. */
    canInstall: boolean;
    /** True when already running as an installed PWA. */
    isStandalone: boolean;
    /** Replays the deferred native prompt. Resolves to the outcome, or null if unavailable. */
    promptInstall: () => Promise<'accepted' | 'dismissed' | null>;
}

const PwaInstallContext = createContext<PwaInstallContextValue>({
    canInstall: false,
    isStandalone: false,
    promptInstall: async () => null,
});

export function PwaInstallProvider({ children }: { children: ReactNode }) {
    const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
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

    return (
        <PwaInstallContext.Provider value={{ canInstall: !!deferred, isStandalone, promptInstall }}>
            {children}
        </PwaInstallContext.Provider>
    );
}

export function usePwaInstall() {
    return useContext(PwaInstallContext);
}
