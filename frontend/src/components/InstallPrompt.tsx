import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, Share } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import BottomSheet from './BottomSheet';
import { usePwaInstall } from '../context/PwaInstallContext';
import { useAuth } from '../context/AuthContext';
import { useConsent } from '../context/ConsentContext';
import { usePush } from '../hooks/usePush';
import { reportAppInstalled, updateNotificationPreferences } from '../api';
import { programInstallDismissedKey, programPushOptInKey } from '../utils/installPromptStorage';
import { trackInstallPromptViewed } from '../utils/tracking';

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
 * iOS Safari has no `beforeinstallprompt`, so the install action opens concise
 * Add-to-Home-Screen instructions instead of trying to invoke a native prompt.
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
    const {
        canInstall,
        isStandalone,
        isIos,
        isIosSafari,
        invitation,
        clearInstallInvitation,
        promptInstall,
    } = usePwaInstall();
    const { user, refreshUser } = useAuth();
    const { consentResolved } = useConsent();
    const location = useLocation();
    const push = usePush(user?.user_id);
    const [snoozed, setSnoozed] = useState(isSnoozed());
    const [justInstalled, setJustInstalled] = useState(false);
    const [pushSnoozed, setPushSnoozed] = useState(isPushSnoozed());
    const [installing, setInstalling] = useState(false);
    const [enablingPush, setEnablingPush] = useState(false);
    const [pushActionError, setPushActionError] = useState<string | null>(null);
    const [showIosHelp, setShowIosHelp] = useState(false);
    const pendingProgramKey = user?.user_id ? programPushOptInKey(user.user_id) : null;
    const programInvitation = invitation?.source === 'program';
    const programContext = invitation?.source === 'program' || Boolean(
        pendingProgramKey && localStorage.getItem(pendingProgramKey),
    );

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
        if (programInvitation && user?.user_id) {
            localStorage.setItem(programInstallDismissedKey(user.user_id, invitation.eventId), '1');
        }
        clearInstallInvitation();
    };

    const install = async () => {
        setInstalling(true);
        try {
            const outcome = await promptInstall();
            if (outcome === 'accepted') {
                setJustInstalled(true);
            } else if (outcome === 'dismissed') {
                dismiss();
            }
        } finally {
            setInstalling(false);
        }
    };

    const dismissPush = () => {
        snoozePush();
        setPushSnoozed(true);
        setJustInstalled(false);
        setPushActionError(null);
        clearInstallInvitation();
    };

    const enableNotifications = async () => {
        setEnablingPush(true);
        setPushActionError(null);
        try {
            const enabled = push.status === 'on' || await push.enable();
            if (!enabled) {
                if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
                    snoozePush();
                    setPushSnoozed(true);
                    setJustInstalled(false);
                    clearInstallInvitation();
                    return;
                }
                setPushActionError('Notifications were not enabled. Please try again.');
                return;
            }
            if (programContext) {
                await updateNotificationPreferences({ push_schedule_updates_enabled: true });
                await refreshUser();
                if (pendingProgramKey) localStorage.removeItem(pendingProgramKey);
            }
            setJustInstalled(false);
            clearInstallInvitation();
        } catch (reason) {
            setPushActionError(reason instanceof Error ? reason.message : 'Could not enable notifications');
        } finally {
            setEnablingPush(false);
        }
    };

    // Admin override (Admin → Users → "Force push"): lets support
    // re-surface the enable-notifications banner for a user who dismissed
    // it, without waiting out PUSH_SNOOZE_HOURS. Only bypasses the snooze,
    // not the other conditions below (e.g. it still won't show if push is
    // already on/unsupported/disabled).
    const forceEnablePush = Boolean(user?.force_enable_push_prompt);
    const needsProgramPreference = programContext && user?.push_schedule_updates_enabled === false;

    const showPushOptIn =
        Boolean(user) &&
        push.resolved &&
        (justInstalled || isStandalone) &&
        (!pushSnoozed || forceEnablePush) &&
        (push.status !== 'on' || needsProgramPreference || enablingPush || Boolean(pushActionError)) &&
        push.status !== 'unsupported' &&
        push.status !== 'disabled';

    // Never render either fixed-bottom banner while the cookie-consent
    // modal's scroll-lock (`html.overflow:hidden`) is still active — see
    // the comment on `consentResolved` in ConsentContext for why.
    if (!consentResolved) return null;

    // Keep both banners out of the onboarding flow: a user still completing
    // onboarding (or on any /onboarding route) shouldn't be nudged to
    // install/enable push — those prompts belong on the explorer afterwards.
    if (location.pathname.startsWith('/onboarding') || user?.needs_onboarding) return null;

    if (showIosHelp) {
        return (
            <BottomSheet title="Install Movida" onClose={() => setShowIosHelp(false)} footer={(
                <button type="button" onClick={() => setShowIosHelp(false)} className="min-h-11 w-full rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                    Done
                </button>
            )}>
                <IosInstallInstructions isSafari={isIosSafari} />
            </BottomSheet>
        );
    }

    if (showPushOptIn) {
        return (
            <PromptPosition>
                <CampaignPromptCard
                    appearance="toast"
                    title={programContext
                        ? needsProgramPreference ? 'Turn on program updates' : 'Turn on notifications'
                        : 'Stay in the loop!'}
                    message={programContext
                        ? 'Get notified when sessions in My Plan change or are cancelled.'
                        : 'Get notified about reminders and activity on this device.'}
                    actionLabel={enablingPush ? 'Turning on…' : 'Turn on notifications'}
                    onAction={enableNotifications}
                    onDismiss={dismissPush}
                    busy={enablingPush || push.busy}
                    error={pushActionError ?? push.error}
                />
            </PromptPosition>
        );
    }

    // Admin override (Admin → Users → "Force install prompt"): lets support
    // re-surface the banner for a user who dismissed it, without waiting out
    // SNOOZE_DAYS. Only bypasses the snooze, not the other conditions below.
    const forceInstall = Boolean(user?.force_install_prompt);

    // Only offered to signed-in users — anonymous visitors get prompted to
    // sign in first elsewhere; installing before that just adds friction.
    if (!user || (!canInstall && !isIos) || isStandalone || (snoozed && !forceInstall && !programInvitation)) return null;

    const installSurface = programContext ? 'program-toast' : 'toast';

    return (
        <PromptPosition>
            <InstallPromptCard
                key={installSurface}
                surface={installSurface}
                title={programContext ? 'Keep your plan up to date' : 'Install Movida'}
                message={programContext
                    ? 'Install Movida for quick access, then turn on notifications when sessions in My Plan change or are cancelled.'
                    : 'Add to your home screen for faster access and notifications.'}
                actionLabel={isIos ? 'How to install' : 'Install app'}
                onInstall={isIos ? () => setShowIosHelp(true) : install}
                onDismiss={forceInstall ? undefined : dismiss}
                installing={installing}
            />
        </PromptPosition>
    );
}

function PromptPosition({ children }: { children: ReactNode }) {
    return (
        <div
            className="fixed inset-x-0 bottom-0 z-[12000] flex justify-center px-3 pb-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
            {children}
        </div>
    );
}

function CampaignPromptCard({
    appearance,
    icon,
    title,
    message,
    actionLabel,
    onAction,
    onDismiss,
    busy = false,
    error,
}: {
    appearance: 'toast' | 'page';
    icon?: ReactNode;
    title: string;
    message: string;
    actionLabel: string;
    onAction: () => void;
    onDismiss?: () => void;
    busy?: boolean;
    error?: string | null;
}) {
    if (appearance === 'toast') {
        return (
            <section aria-label={title} className="flex w-full flex-col gap-4 rounded-field border-2 border-orange-500 bg-orange-400 px-6 py-5 shadow-2xl sm:max-w-md">
                <div className={icon ? 'flex items-center gap-4' : undefined}>
                    {icon}
                    <div className="min-w-0 flex-1">
                        <p className="text-base font-bold text-white">{title}</p>
                        <p className="mt-1 text-sm text-orange-100">{message}</p>
                    </div>
                </div>
                {error ? <p role="alert" className="rounded-field bg-surface/30 px-3 py-2 text-xs text-orange-950">{error}</p> : null}
                <div className="flex gap-3">
                    {onDismiss ? (
                        <button type="button" onClick={onDismiss} className="rounded-field bg-surface/30 px-3 py-2 text-xs font-medium text-orange-700 transition hover:bg-surface/50">
                            Not now
                        </button>
                    ) : null}
                    <button type="button" disabled={busy} onClick={onAction} className="flex-1 rounded-field bg-violet-500 px-4 py-3 text-sm font-bold text-white shadow-md transition hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-60">
                        {actionLabel}
                    </button>
                </div>
            </section>
        );
    }

    return (
        <section aria-label={title} className="w-full rounded-card border border-brand-strong bg-brand px-4 py-4 text-white shadow-2xl sm:max-w-md">
            <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-field bg-surface/15" aria-hidden="true">{icon}</span>
                <div className="min-w-0 flex-1">
                    <p className="text-base font-bold leading-5">{title}</p>
                    <p className="mt-1 text-sm leading-5 text-white/85">{message}</p>
                </div>
            </div>
            {error ? <p role="alert" className="mt-3 rounded-field bg-surface/15 px-3 py-2 text-xs text-white">{error}</p> : null}
            <div className="mt-4 flex items-center gap-2">
                {onDismiss ? (
                    <button type="button" onClick={onDismiss} className="min-h-11 px-3 text-sm font-semibold text-white/85 hover:text-white">
                        Not now
                    </button>
                ) : null}
                <button type="button" disabled={busy} onClick={onAction} className="min-h-11 flex-1 rounded-field bg-action px-4 py-2 text-sm font-bold text-white shadow-md hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">
                    {actionLabel}
                </button>
            </div>
        </section>
    );
}

/**
 * The "Install Movida" card itself: icon, copy, and action buttons.
 * Extracted so the exact same UX/behavior can be reused outside the
 * fixed-bottom toast — e.g. embedded directly in the dedicated `/install`
 * page (`InstallPage`) linked from install-invitation emails.
 *
 * Fires an `install_prompt_viewed` Umami event on mount, tagged with
 * `surface` so the toast and the standalone page can be compared.
 */
export function InstallPromptCard({
    surface,
    onInstall,
    onDismiss,
    title = 'Install Movida',
    message = 'Add to your home screen for faster access and notifications.',
    actionLabel = 'Install app',
    installing = false,
}: {
    surface: 'toast' | 'program-toast' | 'page';
    onInstall: () => void;
    onDismiss?: () => void;
    title?: string;
    message?: string;
    actionLabel?: string;
    installing?: boolean;
}) {
    useEffect(() => {
        trackInstallPromptViewed(surface);
        // Only track once per mount — `surface` is static for a given caller.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <CampaignPromptCard
            appearance={surface === 'page' ? 'page' : 'toast'}
            icon={<img src="/icons/icon-192.png" alt="" className={surface === 'page' ? 'h-10 w-10' : 'h-12 w-12 shrink-0'} />}
            title={title}
            message={message}
            actionLabel={installing ? 'Installing…' : actionLabel}
            onAction={onInstall}
            onDismiss={onDismiss}
            busy={installing}
        />
    );
}

export function IosInstallInstructions({ isSafari }: { isSafari: boolean }) {
    return (
        <div className="space-y-4 text-sm leading-6 text-ink">
            {!isSafari ? <p className="rounded-field bg-blue-50 p-3 text-action">Open this page in Safari to install Movida on your Home Screen.</p> : null}
            <ol className="space-y-4">
                <li className="flex gap-3"><Share size={20} className="mt-0.5 shrink-0 text-action" /><span><strong>1. Tap Share</strong><br /><span className="text-ink-soft">Use the Share button in Safari’s toolbar.</span></span></li>
                <li className="flex gap-3"><Download size={20} className="mt-0.5 shrink-0 text-action" /><span><strong>2. Add to Home Screen</strong><br /><span className="text-ink-soft">Scroll through the actions and choose Add to Home Screen.</span></span></li>
                <li className="flex gap-3"><img src="/icons/icon-192.png" alt="" className="mt-0.5 h-5 w-5 shrink-0" /><span><strong>3. Tap Add</strong><br /><span className="text-ink-soft">Open Movida from your Home Screen, then turn on notifications.</span></span></li>
            </ol>
        </div>
    );
}
