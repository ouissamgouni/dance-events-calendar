import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
    updateNotificationPreferences,
    type UpdateNotificationPreferencesPayload,
} from '../api';

/**
 * Notification & email settings (Settings page).
 *
 * Phase G — renders a 3×2 feature × channel matrix. Rows always land in-app;
 * each cell PATCHes one of six per-feature × per-channel gates
 * (`{email|push}_{event_reminders|social_activity|interest_matches}_enabled`).
 * The Push column is hidden when the browser can't do web push.
 *
 * Also captures the browser IANA timezone once so reminder emails land in
 * the user's local hour, and offers a "Pause all notifications" button
 * that flips all six channel flags to false in a single PATCH.
 */

type FeatureKey = 'event_reminders' | 'social_activity' | 'friends_going' | 'friend_reviews' | 'friend_milestones' | 'interest_matches' | 'promo_codes' | 'review_prompt' | 'milestone_unlocked' | 'event_messages' | 'suggested_events';
type Channel = 'email' | 'push';
type FlagKey =
    | 'email_event_reminders_enabled'
    | 'email_social_activity_enabled'
    | 'email_interest_matches_enabled'
    | 'push_event_reminders_enabled'
    | 'push_social_activity_enabled'
    | 'push_interest_matches_enabled'
    | 'email_promo_codes_enabled'
    | 'push_promo_codes_enabled'
    | 'email_review_prompt_enabled'
    | 'push_review_prompt_enabled'
    | 'email_milestone_unlocked_enabled'
    | 'push_milestone_unlocked_enabled'
    | 'email_friends_going_enabled'
    | 'push_friends_going_enabled'
    | 'email_friend_reviews_enabled'
    | 'push_friend_reviews_enabled'
    | 'email_friend_milestones_enabled'
    | 'push_friend_milestones_enabled'
    | 'email_event_messages_enabled'
    | 'push_event_messages_enabled'
    | 'email_suggested_events_enabled'
    | 'push_suggested_events_enabled';

const FEATURES: {
    key: FeatureKey;
    label: string;
    description: string;
    anchor: string;
}[] = [
        {
            key: 'event_reminders',
            label: 'Event reminders',
            description: "Before events I've RSVP'd to.",
            anchor: 'notify-event-reminders',
        },
        {
            key: 'social_activity',
            label: 'Friends & social',
            description: 'Follows and friend requests.',
            anchor: 'notify-social-activity',
        },
        {
            key: 'friends_going',
            label: 'Friends going',
            description: 'When someone you follow is going to an event.',
            anchor: 'notify-friends-going',
        },
        {
            key: 'friend_reviews',
            label: 'Friend reviews',
            description: 'When someone you follow reviews an event.',
            anchor: 'notify-friend-reviews',
        },
        {
            key: 'friend_milestones',
            label: 'Friend milestones',
            description: 'When someone you follow reaches a milestone.',
            anchor: 'notify-friend-milestones',
        },
        {
            key: 'interest_matches',
            label: 'Interest matches',
            description: 'New events matching your saved searches.',
            anchor: 'notify-interest-matches',
        },
        {
            key: 'promo_codes',
            label: 'Promo codes',
            description: 'When a promo code is approved for an event you saved.',
            anchor: 'notify-promo-codes',
        },
        {
            key: 'review_prompt',
            label: 'Rate your experience',
            description: "After events I've RSVP'd to, ask how it went.",
            anchor: 'notify-review-prompt',
        },
        {
            key: 'milestone_unlocked',
            label: 'Dance Passport achievements',
            description: 'When you unlock new milestones and achievements.',
            anchor: 'notify-milestone-unlocked',
        },
        {
            key: 'event_messages',
            label: 'Event messages',
            description: 'Questions & requests on events you\u2019re going to or saved.',
            anchor: 'notify-event-messages',
        },
        {
            key: 'suggested_events',
            label: 'Suggested events',
            description: 'When an event you suggested is approved.',
            anchor: 'notify-suggested-events',
        },
    ];

function flagKey(channel: Channel, feature: FeatureKey): FlagKey {
    return `${channel}_${feature}_enabled` as FlagKey;
}

const ALL_FLAGS: FlagKey[] = FEATURES.flatMap((f) => [
    flagKey('email', f.key),
    flagKey('push', f.key),
]);

function isWebPushCapable(): boolean {
    if (typeof window === 'undefined') return false;
    return (
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    );
}

// Compact cell switch (no visible label — the row header supplies it).
function CellSwitch({
    checked,
    busy,
    ariaLabel,
    onChange,
}: {
    checked: boolean;
    busy: boolean;
    ariaLabel: string;
    onChange: (value: boolean) => void;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={busy}
            onClick={() => onChange(!checked)}
            className={
                // eslint-disable-next-line no-restricted-syntax -- circular toggle switch is an allowed exception
                'relative shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-60 ' +
                (checked ? 'bg-action' : 'bg-slate-300')
            }
        >
            <span
                className={
                    // eslint-disable-next-line no-restricted-syntax -- circular toggle thumb is an allowed exception
                    'inline-block h-4 w-4 transform rounded-full bg-surface shadow transition-transform ' +
                    (checked ? 'translate-x-4' : 'translate-x-0.5')
                }
            />
        </button>
    );
}

export default function NotificationSettings() {
    const { user, refreshUser } = useAuth();
    const [saving, setSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [savedToast, setSavedToast] = useState(false);
    const toastTimer = useRef<number | null>(null);
    const pushCapable = isWebPushCapable();

    const detectedTz = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch {
            return 'UTC';
        }
    })();
    const storedTz = user?.timezone ?? 'UTC';

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

    const patchOne = async (field: FlagKey | 'timezone' | 'digest_email_enabled', value: boolean | string) => {
        setSaving(field);
        setError(null);
        try {
            const body = { [field]: value } as UpdateNotificationPreferencesPayload;
            await updateNotificationPreferences(body);
            await refreshUser();
            showToast();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save');
        } finally {
            setSaving(null);
        }
    };

    const pauseAll = async () => {
        setSaving('pause-all');
        setError(null);
        try {
            const body: UpdateNotificationPreferencesPayload = {};
            for (const key of ALL_FLAGS) {
                (body as Record<FlagKey, boolean>)[key] = false;
            }
            await updateNotificationPreferences(body);
            await refreshUser();
            showToast();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save');
        } finally {
            setSaving(null);
        }
    };

    if (!user) return null;

    const flagValue = (channel: Channel, feature: FeatureKey): boolean => {
        const key = flagKey(channel, feature) as keyof typeof user;
        const raw = user[key];
        return typeof raw === 'boolean' ? raw : true;
    };

    return (
        <section className="border border-line bg-surface p-4 mb-3">
            <div className="flex items-baseline justify-between gap-4 mb-3">
                <h2 className="text-sm font-semibold text-ink">
                    Notifications &amp; email
                </h2>
                <span
                    className="text-[11px] text-muted"
                    role="status"
                    aria-live="polite"
                >
                    {saving ? 'Saving…' : savedToast ? 'Saved.' : ''}
                </span>
            </div>

            <p className="text-[11px] text-ink-soft mb-3">
                In-app notifications always appear. Toggle email or push per feature.
            </p>

            <div className="overflow-hidden border border-line">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="bg-canvas text-ink-soft">
                            <th className="text-left font-medium px-3 py-2">
                                Feature
                            </th>
                            <th className="font-medium px-3 py-2 w-20">Email</th>
                            {pushCapable && (
                                <th className="font-medium px-3 py-2 w-20">Push</th>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {FEATURES.map((f) => (
                            <tr
                                key={f.key}
                                id={f.anchor}
                                className="border-t border-card-line align-top"
                            >
                                <td className="px-3 py-3">
                                    <div className="font-medium text-ink">
                                        {f.label}
                                    </div>
                                    <div className="text-[11px] text-ink-soft">
                                        {f.description}
                                    </div>
                                </td>
                                <td className="px-3 py-3 text-center">
                                    <CellSwitch
                                        checked={flagValue('email', f.key)}
                                        busy={saving === flagKey('email', f.key)}
                                        ariaLabel={`${f.label} — email`}
                                        onChange={(v) =>
                                            patchOne(flagKey('email', f.key), v)
                                        }
                                    />
                                </td>
                                {pushCapable && (
                                    <td className="px-3 py-3 text-center">
                                        <CellSwitch
                                            checked={flagValue('push', f.key)}
                                            busy={saving === flagKey('push', f.key)}
                                            ariaLabel={`${f.label} — push`}
                                            onChange={(v) =>
                                                patchOne(flagKey('push', f.key), v)
                                            }
                                        />
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="mt-3">
                <button
                    type="button"
                    onClick={pauseAll}
                    disabled={saving === 'pause-all'}
                    className="text-xs text-ink-soft hover:text-ink underline underline-offset-2 disabled:text-muted"
                >
                    {saving === 'pause-all' ? 'Pausing…' : 'Pause all notifications'}
                </button>
            </div>

            <div
                id="notify-email-digest"
                className="pt-3 mt-3 border-t border-card-line flex items-start justify-between gap-3"
            >
                <div>
                    <div className="font-medium text-ink text-xs">Email digest</div>
                    <div className="text-[11px] text-ink-soft">
                        Master switch for the combined activity digest email. Off stops
                        the digest entirely, whatever the per-feature email toggles say.
                    </div>
                </div>
                <CellSwitch
                    checked={
                        typeof user.digest_email_enabled === 'boolean'
                            ? user.digest_email_enabled
                            : true
                    }
                    busy={saving === 'digest_email_enabled'}
                    ariaLabel="Email digest — master switch"
                    onChange={(v) => patchOne('digest_email_enabled', v)}
                />
            </div>

            <div className="pt-3 mt-3 border-t border-card-line">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft mb-1.5">
                    Timezone
                </div>
                <p className="text-xs text-ink-soft">
                    Reminder times are shown in{' '}
                    <span className="font-mono text-ink">{storedTz}</span>.
                </p>
                {detectedTz !== storedTz && (
                    <button
                        type="button"
                        disabled={saving === 'timezone'}
                        onClick={() => patchOne('timezone', detectedTz)}
                        className="mt-2 text-xs text-action hover:text-action disabled:text-muted"
                    >
                        Use my detected timezone ({detectedTz})
                    </button>
                )}
            </div>

            {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </section>
    );
}
