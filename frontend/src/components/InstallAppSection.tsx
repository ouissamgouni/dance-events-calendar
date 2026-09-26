import { useState } from 'react';
import { usePwaInstall } from '../context/PwaInstallContext';
import BottomSheet from './BottomSheet';
import { IosInstallInstructions } from './InstallPrompt';

/**
 * Persistent "Install app" entry for the Settings page.
 *
 * Complements the transient {@link InstallPrompt} banner: a user who
 * dismissed (snoozed) or missed that banner can still trigger the native
 * install flow here at any time, whether signed in or not — install is a
 * device capability, not an account feature.
 */
export default function InstallAppSection() {
    const { canInstall, isStandalone, isIos, isIosSafari, promptInstall } = usePwaInstall();
    const [installing, setInstalling] = useState(false);
    const [showIosHelp, setShowIosHelp] = useState(false);

    if (isStandalone) {
        return (
            <section className="border border-line bg-surface p-4 mb-3">
                <h2 className="text-sm font-semibold text-ink mb-1">Install app</h2>
                <p className="text-xs text-ink-soft">Movida is installed on this device.</p>
            </section>
        );
    }

    if (!canInstall && !isIos) return null;

    const install = async () => {
        setInstalling(true);
        try {
            await promptInstall();
        } finally {
            setInstalling(false);
        }
    };

    return (
        <section className="border border-line bg-surface p-4 mb-3">
            <h2 className="text-sm font-semibold text-ink mb-1">Install app</h2>
            <p className="text-xs text-ink-soft mb-2">
                {isIos ? 'Add Movida from Safari to keep it on your Home Screen.' : 'Add Movida to your home screen for faster access.'}
            </p>
            <button
                type="button"
                disabled={installing}
                onClick={isIos ? () => setShowIosHelp(true) : install}
                className="bg-action px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
                {installing ? 'Installing…' : isIos ? 'How to install' : 'Install'}
            </button>
            {showIosHelp ? (
                <BottomSheet title="Install Movida" onClose={() => setShowIosHelp(false)} footer={(
                    <button type="button" onClick={() => setShowIosHelp(false)} className="min-h-11 w-full rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                        Done
                    </button>
                )}>
                    <IosInstallInstructions isSafari={isIosSafari} />
                </BottomSheet>
            ) : null}
        </section>
    );
}
