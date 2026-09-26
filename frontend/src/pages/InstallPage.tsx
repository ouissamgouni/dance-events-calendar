import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { usePwaInstall } from '../context/PwaInstallContext';
import { useAuth } from '../context/AuthContext';
import BottomSheet from '../components/BottomSheet';
import { InstallPromptCard, IosInstallInstructions } from '../components/InstallPrompt';

/**
 * Dedicated, linkable "Install Movida" page — the destination for the
 * install-invitation email sent from Admin → Users ("Send install email").
 *
 * Renders the exact same {@link InstallPromptCard} used by the bottom-of-
 * screen toast (same copy, same `usePwaInstall().promptInstall()` call,
 * same Umami tracking), just embedded in normal page flow instead of a
 * fixed banner. Falls back to a friendly explanation when the card can't
 * be shown here (not signed in, already installed, or the browser has no
 * `beforeinstallprompt` support, e.g. iOS Safari).
 */
export default function InstallPage() {
    const { canInstall, isStandalone, isIos, isIosSafari, promptInstall } = usePwaInstall();
    const { user, loading } = useAuth();
    const [showIosHelp, setShowIosHelp] = useState(false);

    const install = () => {
        promptInstall();
    };

    return (
        <>
            <Helmet>
                <title>Install Movida</title>
            </Helmet>
            <div className="max-w-md mx-auto px-4 py-10 flex flex-col items-center gap-6 text-center">
                <img src="/icons/icon-192.png" alt="" className="h-16 w-16" />
                <div>
                    <h1 className="text-2xl font-bold text-ink">Install Movida</h1>
                    <p className="mt-2 text-sm text-ink-soft">
                        Get faster access, home screen shortcuts, and reminders for events you're going to — right on your device.
                    </p>
                </div>

                {loading ? null : isStandalone ? (
                    <div className="w-full border border-line bg-canvas px-6 py-5 text-sm text-ink">
                        You already have Movida installed on this device 🎉
                    </div>
                ) : !user ? (
                    <div className="w-full border border-blue-100 bg-blue-50 px-6 py-5 text-sm text-action">
                        <p className="mb-3">Sign in first to install Movida.</p>
                        <Link
                            to="/login?next=/install"
                            className="inline-block bg-action text-white hover:bg-action px-4 py-2 text-sm font-medium transition"
                        >
                            Sign in
                        </Link>
                    </div>
                ) : canInstall || isIos ? (
                    <div className="w-full flex justify-center">
                        <InstallPromptCard
                            surface="page"
                            onInstall={isIos ? () => setShowIosHelp(true) : install}
                            actionLabel={isIos ? 'How to install' : 'Install app'}
                        />
                    </div>
                ) : (
                    <div className="w-full border border-line bg-canvas px-6 py-5 text-sm text-ink text-left space-y-2">
                        <p>Your browser can't install Movida directly here — but you can still add it manually:</p>
                        <p><strong>iPhone/iPad:</strong> In Safari, tap Share, then "Add to Home Screen".</p>
                        <p><strong>Android:</strong> In Chrome, tap the ⋮ menu, then "Install app" (or "Add to Home screen").</p>
                        <p>Once added, open Movida from your Home Screen and allow notifications so you don't miss reminders.</p>
                    </div>
                )}
            </div>
            {showIosHelp ? (
                <BottomSheet title="Install Movida" onClose={() => setShowIosHelp(false)} footer={(
                    <button type="button" onClick={() => setShowIosHelp(false)} className="min-h-11 w-full rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                        Done
                    </button>
                )}>
                    <IosInstallInstructions isSafari={isIosSafari} />
                </BottomSheet>
            ) : null}
        </>
    );
}
