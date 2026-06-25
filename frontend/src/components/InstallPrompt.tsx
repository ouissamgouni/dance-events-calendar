import { useEffect, useState } from 'react';

/**
 * Dismissible "Install app" prompt.
 *
 * Listens for the Chromium `beforeinstallprompt` event (Android/desktop
 * Chrome/Edge), suppresses the browser mini-infobar, and surfaces a branded
 * bottom banner instead. Tapping "Install" replays the deferred prompt;
 * dismissing it (or a successful install) is remembered in localStorage so we
 * never nag a user who already decided.
 *
 * iOS Safari has no `beforeinstallprompt`, so the banner simply never shows
 * there — Add-to-Home-Screen remains available via the share sheet.
 */
const DISMISS_KEY = 'movida:install-dismissed';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export default function InstallPrompt() {
    const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (localStorage.getItem(DISMISS_KEY)) return;
        // Already running as an installed PWA — nothing to prompt.
        if (window.matchMedia('(display-mode: standalone)').matches) return;

        const onPrompt = (e: Event) => {
            e.preventDefault();
            setDeferred(e as BeforeInstallPromptEvent);
            setVisible(true);
        };
        const onInstalled = () => {
            localStorage.setItem(DISMISS_KEY, '1');
            setVisible(false);
            setDeferred(null);
        };
        window.addEventListener('beforeinstallprompt', onPrompt);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('beforeinstallprompt', onPrompt);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const dismiss = () => {
        localStorage.setItem(DISMISS_KEY, '1');
        setVisible(false);
    };

    const install = async () => {
        if (!deferred) return;
        await deferred.prompt();
        try {
            await deferred.userChoice;
        } finally {
            // One shot per spec — clear regardless of outcome.
            localStorage.setItem(DISMISS_KEY, '1');
            setVisible(false);
            setDeferred(null);
        }
    };

    if (!visible) return null;

    return (
        <div
            className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
            <div className="w-full max-w-md flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-lg">
                <img src="/icons/icon-192.png" alt="" className="h-9 w-9 rounded-lg shrink-0" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900">Install Movida</p>
                    <p className="text-xs text-slate-500">Add to your home screen for faster access.</p>
                </div>
                <button
                    type="button"
                    onClick={dismiss}
                    className="shrink-0 text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
                >
                    Not now
                </button>
                <button
                    type="button"
                    onClick={install}
                    className="shrink-0 text-xs font-medium bg-blue-500 text-white hover:bg-blue-600 px-3 py-1.5 rounded"
                >
                    Install
                </button>
            </div>
        </div>
    );
}
