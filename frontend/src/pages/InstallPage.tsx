import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { usePwaInstall } from '../context/PwaInstallContext';
import BottomSheet from '../components/BottomSheet';
import { InAppBrowserNotice, InstallPromptCard, IosInstallInstructions } from '../components/InstallPrompt';

/**
 * Dedicated, linkable "Install Movida" page — the destination for the
 * install-invitation email sent from Admin → Users ("Send install email").
 *
 * Renders the exact same {@link InstallPromptCard} used by the bottom-of-
 * screen toast (same copy, same `usePwaInstall().promptInstall()` call,
 * same Umami tracking), just embedded in normal page flow instead of a
 * fixed banner. Falls back to manual instructions when the card can't
 * be shown here (already installed, in-app browser, or no
 * `beforeinstallprompt` support).
 */
export default function InstallPage() {
    const { canInstall, isStandalone, isIos, isInAppBrowser, promptInstall } = usePwaInstall();
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

                {isStandalone ? (
                    <div className="w-full border border-line bg-canvas px-6 py-5 text-sm text-ink">
                        You already have Movida installed on this device 🎉
                    </div>
                ) : isInAppBrowser && !isIos ? (
                    <InAppBrowserNotice />
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
                        <p><strong>iPhone/iPad:</strong> In Safari, Chrome or Edge, open the Share menu (in Safari: ••• then Share), then "Add to Home Screen".</p>
                        <p><strong>Android:</strong> In Chrome, tap the ⋮ menu, then "Add to Home screen" and "Install".</p>
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
                    <IosInstallInstructions inAppBrowser={isInAppBrowser} />
                </BottomSheet>
            ) : null}
        </>
    );
}
