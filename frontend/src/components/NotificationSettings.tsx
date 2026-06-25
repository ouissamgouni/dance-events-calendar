import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { updateNotificationPreferences } from '../api';
import { usePush } from '../hooks/usePush';

/**
 * Notification & email settings (Settings page).
 *
 * Lets a signed-in user toggle the two email categories (upcoming-event
 * reminders + friend/event activity digests) and confirm the IANA timezone
 * used to render reminder times. The timezone is auto-captured from the
 * browser on first signed-in load (see {@link useAuth} consumers) — this
 * section surfaces it and offers a one-click "use detected" correction when
 * the stored value drifts from the browser's current zone.
 *
 * All writes go through ``PATCH /auth/notification-preferences`` and then
 * ``refreshUser()`` so the AuthContext mirror stays authoritative. Edits are
 * optimistic with rollback on failure.
 */
export default function NotificationSettings() {
    const { user, refreshUser } = useAuth();
    const [saving, setSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [savedToast, setSavedToast] = useState(false);
    const toastTimer = useRef<number | null>(null);
    const push = usePush();

    const detectedTz = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch {
            return 'UTC';
        }
    })();
    const storedTz = user?.timezone ?? 'UTC';
    const reminderOn = user?.reminder_email_enabled ?? true;
    const activityOn = user?.activity_email_enabled ?? true;

    // Capture the browser timezone once when it differs from the stored
    // value AND the stored value is still the server default ("UTC"). This
    // backfills brand-new accounts without ever overwriting a timezone the
    // user (or a prior capture) has deliberately set.
    const captureGuard = useRef(false);
    useEffect(() => {
        if (!user || captureGuard.current) return;
        if (storedTz === 'UTC' && detectedTz !== 'UTC') {
            captureGuard.current = true;
            updateNotificationPreferences({ timezone: detectedTz })
                .then(() => refreshUser())
                .catch(() => {
                    // Non-fatal: the user can still set it manually below.
                    captureGuard.current = false;
                });
        }
    }, [user, storedTz, detectedTz, refreshUser]);

    useEffect(
        () => () => {
            if (toastTimer.current) window.clearTimeout(toastTimer.current);
        },
        [],
    );

    const showToast = () => {
        setSavedToast(true);
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setSavedToast(false), 2000);
    };

    const patch = async (
        field:
            | 'reminder_email_enabled'
            | 'activity_email_enabled'
            | 'push_enabled'
            | 'timezone',
        value: boolean | string,
    ) => {
        setSaving(field);
        setError(null);
        try {
            await updateNotificationPreferences({ [field]: value });
            await refreshUser();
            showToast();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save');
        } finally {
            setSaving(null);
        }
    };

    // The push toggle drives two things at once: this browser's subscription
    // (via usePush) and the server-side ``push_enabled`` gate. Enabling
    // subscribes + flips the flag on; disabling unsubscribes + flips it off.
    const togglePush = async (next: boolean) => {
        if (next) {
            await push.enable();
            await patch('push_enabled', true);
        } else {
            await push.disable();
            await patch('push_enabled', false);
        }
    };

    const pushChecked = push.status === 'on';
    const pushVisible = push.status !== 'unsupported' && push.status !== 'disabled';
    const pushDenied = push.status === 'denied';

    if (!user) return null;

    return (
        <section className="border border-slate-200 bg-white p-4 mb-3">
            <div className="flex items-baseline justify-between gap-4 mb-3">
                <h2 className="text-sm font-semibold text-slate-900">Notifications &amp; email</h2>
                <span className="text-[11px] text-slate-400" role="status" aria-live="polite">
                    {saving ? 'Saving…' : savedToast ? 'Saved.' : ''}
                </span>
            </div>

            <div className="space-y-4">
                <ToggleRow
                    label="Event reminders"
                    description="Email me a reminder before events I'm going to."
                    checked={reminderOn}
                    busy={saving === 'reminder_email_enabled'}
                    onChange={(v) => patch('reminder_email_enabled', v)}
                />
                <ToggleRow
                    label="Activity emails"
                    description="Email me when friends are going to events, follow me, or accept a request."
                    checked={activityOn}
                    busy={saving === 'activity_email_enabled'}
                    onChange={(v) => patch('activity_email_enabled', v)}
                />

                {pushVisible && (
                    <ToggleRow
                        label="Push notifications"
                        description={
                            pushDenied
                                ? 'Blocked in your browser settings — re-enable notifications for this site to turn on.'
                                : 'Get reminders and activity alerts on this device, even when Movida is closed.'
                        }
                        checked={pushChecked}
                        busy={push.busy || saving === 'push_enabled'}
                        disabled={pushDenied}
                        onChange={togglePush}
                    />
                )}

                <div className="pt-1 border-t border-slate-100">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                        Timezone
                    </div>
                    <p className="text-xs text-slate-600">
                        Reminder times are shown in{' '}
                        <span className="font-mono text-slate-800">{storedTz}</span>.
                    </p>
                    {detectedTz !== storedTz && (
                        <button
                            type="button"
                            disabled={saving === 'timezone'}
                            onClick={() => patch('timezone', detectedTz)}
                            className="mt-2 text-xs text-blue-600 hover:text-blue-700 disabled:text-slate-400"
                        >
                            Use my detected timezone ({detectedTz})
                        </button>
                    )}
                </div>
            </div>

            {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
            {push.error && <p className="mt-2 text-xs text-red-600">{push.error}</p>}
        </section>
    );
}

function ToggleRow({
    label,
    description,
    checked,
    busy,
    disabled,
    onChange,
}: {
    label: string;
    description: string;
    checked: boolean;
    busy: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">{label}</div>
                <p className="text-xs text-slate-500 mt-0.5">{description}</p>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={label}
                disabled={busy || disabled}
                onClick={() => onChange(!checked)}
                className={
                    'relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 ' +
                    (checked ? 'bg-blue-500' : 'bg-slate-300')
                }
            >
                <span
                    className={
                        'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' +
                        (checked ? 'translate-x-5' : 'translate-x-0.5')
                    }
                />
            </button>
        </div>
    );
}
