import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { usePwaInstall } from '../context/PwaInstallContext';
import { useAuth } from '../context/AuthContext';
import { InstallPromptCard } from '../components/InstallPrompt';

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
    const { canInstall, isStandalone, promptInstall } = usePwaInstall();
    const { user, loading } = useAuth();

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
                    <h1 className="text-2xl font-bold text-slate-900">Install Movida</h1>
                    <p className="mt-2 text-sm text-slate-600">
                        Get faster access, home screen shortcuts, and reminders for events you're going to — right on your device.
                    </p>
                </div>

                {loading ? null : isStandalone ? (
                    <div className="w-full border border-slate-200 bg-slate-50 px-6 py-5 text-sm text-slate-700">
                        You already have Movida installed on this device 🎉
                    </div>
                ) : !user ? (
                    <div className="w-full border border-blue-100 bg-blue-50 px-6 py-5 text-sm text-blue-700">
                        <p className="mb-3">Sign in first to install Movida.</p>
                        <Link
                            to="/login?next=/install"
                            className="inline-block bg-blue-500 text-white hover:bg-blue-600 px-4 py-2 text-sm font-medium transition"
                        >
                            Sign in
                        </Link>
                    </div>
                ) : canInstall ? (
                    <div className="w-full flex justify-center">
                        <InstallPromptCard surface="page" onInstall={install} />
                    </div>
                ) : (
                    <div className="w-full border border-slate-200 bg-slate-50 px-6 py-5 text-sm text-slate-700">
                        Your browser can't install Movida directly here. On iPhone/iPad, tap the Share icon in Safari and choose "Add to Home Screen".
                    </div>
                )}
            </div>
        </>
    );
}
