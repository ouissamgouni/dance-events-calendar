import { useEffect, useRef, useState } from 'react';
import { usePwaInstall } from '../context/PwaInstallContext';
import { useAuth } from '../context/AuthContext';
import { useConsent } from '../context/ConsentContext';
import { usePush } from '../hooks/usePush';
import { reportAppInstalled } from '../api';

/**
 * Dismissible "Install app" banner + post-install notification opt-in.
 *
 * Install state (the deferred `beforeinstallprompt`) lives in
 * {@link usePwaInstall} so the same native prompt can also be triggered from
 * the persistent "Install app" row in Settings. Dismissing the banner
 * ("Not now") only snoozes it for {@link SNOOZE_DAYS} days — it is not a
 * permanent dead end, since the user may well want to install later.
 *
 * Right after a successful install (and on every subsequent app open while
 * push is still not enabled) we surface a small follow-up asking to enable
 * notifications. This is a deliberate second step (double opt-in) tied to
 * its own button click, rather than auto-requesting permission, since
 * browsers can drop user-activation across the async install flow and an
 * unprompted permission request would look like a surprise popup.
 *
 * Dismissing it ("Not now") snoozes it for {@link PUSH_SNOOZE_HOURS} hours
 * (its own key, separate from the install banner's snooze) rather than
 * hiding it forever — a user who missed or postponed the invitation still
 * gets nudged again later, on top of always being able to enable push from
 * the persistent toggle in Account Settings.
 *
 * Only shown to signed-in users: `usePush()` rebinds an existing browser
 * subscription's owner on the server whenever the signed-in user changes,
 * but there is no such rebind target while anonymous, so there is no upside
 * to prompting before sign-in — it would just create a device subscription
 * with no account attached.
 *
 * iOS Safari has no `beforeinstallprompt`, so the banner simply never shows
 * there — Add-to-Home-Screen remains available via the share sheet.
 */
const SNOOZE_KEY = 'movida:install-snooze-until';
const SNOOZE_DAYS = 14;

function isSnoozed(): boolean {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    const until = Number(raw);
    return Number.isFinite(until) && Date.now() < until;
}

function snooze() {
    const until = Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000;
    localStorage.setItem(SNOOZE_KEY, String(until));
}

// Separate, shorter snooze for the post-install "enable push" nudge. Unlike
// the install banner (which only gets one shot via the browser's one-time
// beforeinstallprompt event), this banner can re-show on every app open, so
// dismissing it needs its own persisted cooldown or it would reappear
// immediately on the next render/reload.
const PUSH_SNOOZE_KEY = 'movida:push-optin-snooze-until';
const PUSH_SNOOZE_HOURS = 24;

function isPushSnoozed(): boolean {
    const raw = localStorage.getItem(PUSH_SNOOZE_KEY);
    if (!raw) return false;
    const until = Number(raw);
    return Number.isFinite(until) && Date.now() < until;
}

function snoozePush() {
    const until = Date.now() + PUSH_SNOOZE_HOURS * 60 * 60 * 1000;
    localStorage.setItem(PUSH_SNOOZE_KEY, String(until));
}

export default function InstallPrompt() {
    const { canInstall, isStandalone, promptInstall } = usePwaInstall();
    const { user } = useAuth();
    const { consentResolved } = useConsent();
    const push = usePush(user?.user_id);
    const [snoozed, setSnoozed] = useState(isSnoozed());
    const [justInstalled, setJustInstalled] = useState(false);
    const [pushSnoozed, setPushSnoozed] = useState(isPushSnoozed());

    // Re-check snooze expiry each time canInstall flips true (e.g. a fresh
    // beforeinstallprompt fired this session).
    useEffect(() => {
        if (canInstall) setSnoozed(isSnoozed());
    }, [canInstall]);

    // Re-check the push opt-in snooze whenever the app is (re)opened installed,
    // so a user who dismissed the nudge and comes back after the cooldown
    // sees it again — dismissing it isn't a one-shot, permanent miss.
    useEffect(() => {
        if (isStandalone) setPushSnoozed(isPushSnoozed());
    }, [isStandalone]);

    // Record the first time a signed-in user is observed running as an
    // installed PWA, powering the "Installed app" column in Admin → Users.
    // Idempotent server-side (only sets installed_at once), so it's safe to
    // call again on a later load; the ref just avoids re-firing on every
    // render within this mount.
    const reportedInstallRef = useRef(false);
    useEffect(() => {
        if (!isStandalone || !user || reportedInstallRef.current) return;
        reportedInstallRef.current = true;
        reportAppInstalled().catch(() => {
            reportedInstallRef.current = false;
        });
    }, [isStandalone, user]);

    const dismiss = () => {
        snooze();
        setSnoozed(true);
    };

    const install = async () => {
        const outcome = await promptInstall();
        if (outcome === 'accepted') {
            setJustInstalled(true);
        } else if (outcome === 'dismissed') {
            snooze();
            setSnoozed(true);
        }
    };

    const dismissPush = () => {
        snoozePush();
        setPushSnoozed(true);
        setJustInstalled(false);
    };

    const showPushOptIn =
        Boolean(user) &&
        push.resolved &&
        (justInstalled || isStandalone) &&
        !pushSnoozed &&
        push.status !== 'on' &&
        push.status !== 'unsupported' &&
        push.status !== 'disabled';

    // Never render either fixed-bottom banner while the cookie-consent
    // modal's scroll-lock (`html.overflow:hidden`) is still active — see
    // the comment on `consentResolved` in ConsentContext for why.
    if (!consentResolved) return null;

    if (showPushOptIn) {
        return (
            <div
                className="fixed inset-x-0 bottom-0 z-[8500] flex justify-center px-3 pb-3"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
            >
                <div className="w-full sm:max-w-md flex flex-col gap-3 border-2 border-orange-500 bg-orange-400 px-6 py-5 shadow-2xl rounded-lg">
                    <div>
                        <p className="text-base font-bold text-white">Stay in the loop!</p>
                        <p className="text-sm text-orange-100 mt-1">Get notified about reminders and activity on this device.</p>
                    </div>
                    <div className="flex gap-3">
                        <button
                            type="button"
                            onClick={dismissPush}
                            className="text-xs font-medium text-orange-700 bg-white/30 hover:bg-white/50 px-3 py-2 rounded transition"
                        >
                            Not now
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                push.enable();
                                setJustInstalled(false);
                            }}
                            className="flex-1 text-sm font-bold bg-violet-500 text-white hover:bg-violet-600 px-4 py-3 rounded transition shadow-md"
                        >
                            Enable Notifications
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Admin override (Admin → Users → "Force install prompt"): lets support
    // re-surface the banner for a user who dismissed it, without waiting out
    // SNOOZE_DAYS. Only bypasses the snooze, not the other conditions below.
    const forceInstall = Boolean(user?.force_install_prompt);

    // Only offered to signed-in users — anonymous visitors get prompted to
    // sign in first elsewhere; installing before that just adds friction.
    if (!user || !canInstall || isStandalone || (snoozed && !forceInstall)) return null;

    return (
        <div
            className="fixed inset-x-0 bottom-0 z-[8500] flex justify-center px-3 pb-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
            <div className="w-full sm:max-w-md flex flex-col gap-4 border-2 border-orange-500 bg-orange-400 px-6 py-5 shadow-2xl rounded-lg">
                <div className="flex items-center gap-4">
                    <img src="/icons/icon-192.png" alt="" className="h-12 w-12 shrink-0" />
                    <div className="min-w-0 flex-1">
                        <p className="text-base font-bold text-white">Install Movida</p>
                        <p className="text-sm text-orange-100">Add to your home screen for faster access.</p>
                    </div>
                </div>
                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={dismiss}
                        className="text-xs font-medium text-orange-700 bg-white/30 hover:bg-white/50 px-3 py-2 rounded transition"
                    >
                        Not now
                    </button>
                    <button
                        type="button"
                        onClick={install}
                        className="flex-1 text-sm font-bold bg-violet-500 text-white hover:bg-violet-600 px-4 py-3 rounded transition shadow-md"
                    >
                        Install App
                    </button>
                </div>
            </div>
        </div>
    );
}
