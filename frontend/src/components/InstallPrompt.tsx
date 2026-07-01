import { useEffect, useState } from 'react';
import { usePwaInstall } from '../context/PwaInstallContext';
import { usePush } from '../hooks/usePush';

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
    const push = usePush();
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
        (justInstalled || isStandalone) &&
        !pushSnoozed &&
        push.status !== 'on' &&
        push.status !== 'unsupported' &&
        push.status !== 'disabled';

    if (showPushOptIn) {
        return (
            <div
                className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
            >
                <div className="w-full max-w-md flex items-center gap-3 border border-slate-200 bg-white px-4 py-3 shadow-lg">
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-900">Stay in the loop?</p>
                        <p className="text-xs text-slate-500">Get notified about reminders and activity on this device.</p>
                    </div>
                    <button
                        type="button"
                        onClick={dismissPush}
                        className="shrink-0 text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
                    >
                        Not now
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            push.enable();
                            setJustInstalled(false);
                        }}
                        className="shrink-0 text-xs font-medium bg-blue-500 text-white hover:bg-blue-600 px-3 py-1.5"
                    >
                        Enable
                    </button>
                </div>
            </div>
        );
    }

    if (!canInstall || isStandalone || snoozed) return null;

    return (
        <div
            className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
            <div className="w-full max-w-md flex items-center gap-3 border border-slate-200 bg-white px-4 py-3 shadow-lg">
                <img src="/icons/icon-192.png" alt="" className="h-9 w-9 shrink-0" />
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
                    className="shrink-0 text-xs font-medium bg-blue-500 text-white hover:bg-blue-600 px-3 py-1.5"
                >
                    Install
                </button>
            </div>
        </div>
    );
}
