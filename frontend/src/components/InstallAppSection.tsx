import { useState } from 'react';
import { usePwaInstall } from '../context/PwaInstallContext';

/**
 * Persistent "Install app" entry for the Settings page.
 *
 * Complements the transient {@link InstallPrompt} banner: a user who
 * dismissed (snoozed) or missed that banner can still trigger the native
 * install flow here at any time, whether signed in or not — install is a
 * device capability, not an account feature.
 */
export default function InstallAppSection() {
    const { canInstall, isStandalone, promptInstall } = usePwaInstall();
    const [installing, setInstalling] = useState(false);

    if (isStandalone) {
        return (
            <section className="border border-slate-200 bg-white p-4 mb-3">
                <h2 className="text-sm font-semibold text-slate-900 mb-1">Install app</h2>
                <p className="text-xs text-slate-500">Movida is installed on this device.</p>
            </section>
        );
    }

    if (!canInstall) return null;

    const install = async () => {
        setInstalling(true);
        try {
            await promptInstall();
        } finally {
            setInstalling(false);
        }
    };

    return (
        <section className="border border-slate-200 bg-white p-4 mb-3">
            <h2 className="text-sm font-semibold text-slate-900 mb-1">Install app</h2>
            <p className="text-xs text-slate-500 mb-2">
                Add Movida to your home screen for faster access.
            </p>
            <button
                type="button"
                disabled={installing}
                onClick={install}
                className="bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 disabled:opacity-60"
            >
                {installing ? 'Installing…' : 'Install'}
            </button>
        </section>
    );
}
