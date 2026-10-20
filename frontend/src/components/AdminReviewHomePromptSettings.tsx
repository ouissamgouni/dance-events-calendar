import { useEffect, useState } from 'react';
import { fetchReviewPromptStats, fetchSettings, updateSettings, type ReviewPromptStats, type SiteSettings } from '../api';

type IntKey =
    | 'review_home_prompt_cooldown_hours'
    | 'review_home_prompt_max_impressions_per_event'
    | 'review_home_prompt_max_event_age_days'
    | 'review_home_prompt_fatigue_dismissals'
    | 'review_home_prompt_fatigue_pause_days'
    | 'similar_events_radius_local_km'
    | 'similar_events_radius_regional_km'
    | 'similar_events_radius_international_km'
    | 'similar_events_limit';

const INT_FIELDS: { key: IntKey; label: string; help: string; fallback: number; max: number }[] = [
    { key: 'review_home_prompt_cooldown_hours', label: 'Cooldown (hours)', help: 'Minimum gap between two Home prompts, across events', fallback: 72, max: 2160 },
    { key: 'review_home_prompt_max_impressions_per_event', label: 'Max asks per event', help: 'First ask + reminders; afterwards only the rail and notifications', fallback: 2, max: 10 },
    { key: 'review_home_prompt_max_event_age_days', label: 'Max event age (days)', help: 'Only events that ended within this window are prompted', fallback: 14, max: 365 },
    { key: 'review_home_prompt_fatigue_dismissals', label: 'Fatigue: ignores in a row', help: 'Consecutive prompts without a review before pausing', fallback: 4, max: 50 },
    { key: 'review_home_prompt_fatigue_pause_days', label: 'Fatigue: pause (days)', help: 'How long prompts pause after the fatigue threshold', fallback: 30, max: 365 },
    { key: 'similar_events_radius_local_km', label: 'Similar: local radius (km)', help: 'Around a local (or unknown reach) event', fallback: 25, max: 20000 },
    { key: 'similar_events_radius_regional_km', label: 'Similar: regional radius (km)', help: 'Regional+ events only', fallback: 150, max: 20000 },
    { key: 'similar_events_radius_international_km', label: 'Similar: international radius (km)', help: "Used when the user has no international search area; international events only", fallback: 1500, max: 20000 },
    { key: 'similar_events_limit', label: 'Similar: cards shown', help: 'Cards in the thanks-screen rail', fallback: 6, max: 24 },
];

const ENTRY_POINT_LABELS: Record<string, string> = {
    'home-prompt': 'Home prompt',
    'rate-next': 'Rate next (chain)',
    'for-you-share-experience': 'Share your experience rail',
    notification: 'In-app notification',
    'notification-push': 'Push',
    'notification-email': 'Email',
    detail: 'Event page',
    unknown: 'Unknown (before tracking)',
};

type ToggleKey = 'review_home_prompt_enabled' | 'similar_events_enabled';

const TOGGLES: { key: ToggleKey; label: string; help: string }[] = [
    {
        key: 'review_home_prompt_enabled',
        label: 'Home review prompt',
        help: 'Opens the review wizard on Home (once per session) for the latest attended, unreviewed event. Admin Send now with the “Home prompt” channel skips the cooldown and fatigue pause.',
    },
    {
        key: 'similar_events_enabled',
        label: 'Similar events after review',
        help: 'Shows a “Similar events you might like” rail on the review success sheet, from every review entry point.',
    },
];

interface Props {
    onMessage: (msg: string) => void;
    ratingsEnabled?: boolean;
    onOpenFeatureFlags?: () => void;
}

/** Admin settings + last-30-days stats for the Home review prompt and similar-events rail. */
export default function AdminReviewHomePromptSettings({ onMessage, ratingsEnabled = true, onOpenFeatureFlags }: Props) {
    const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>({ review_home_prompt_enabled: true, similar_events_enabled: true });
    const [values, setValues] = useState<Record<IntKey, number>>(
        () => Object.fromEntries(INT_FIELDS.map((f) => [f.key, f.fallback])) as Record<IntKey, number>,
    );
    const [stats, setStats] = useState<ReviewPromptStats | null>(null);

    useEffect(() => {
        fetchSettings()
            .then((s: SiteSettings) => {
                setToggles({
                    review_home_prompt_enabled: s.review_home_prompt_enabled ?? true,
                    similar_events_enabled: s.similar_events_enabled ?? true,
                });
                setValues((prev) => {
                    const next = { ...prev };
                    for (const f of INT_FIELDS) next[f.key] = s[f.key] ?? f.fallback;
                    return next;
                });
            })
            .catch(() => { });
        fetchReviewPromptStats(30).then(setStats).catch(() => setStats(null));
    }, []);

    const toggle = async ({ key, label }: (typeof TOGGLES)[number]) => {
        const next = !toggles[key];
        setToggles((prev) => ({ ...prev, [key]: next }));
        try {
            await updateSettings({ [key]: next });
            onMessage(`${label} ${next ? 'enabled' : 'disabled'}.`);
        } catch {
            setToggles((prev) => ({ ...prev, [key]: !next }));
            onMessage(`Failed to update ${label}.`);
        }
    };

    const save = async (field: (typeof INT_FIELDS)[number], value: number) => {
        if (!Number.isFinite(value) || value < 1 || value > field.max) return;
        try {
            await updateSettings({ [field.key]: value });
            onMessage(`${field.label} set to ${value}.`);
        } catch {
            onMessage(`Failed to update ${field.label.toLowerCase()}.`);
        }
    };

    const conversion = stats && stats.shown > 0 ? Math.round((stats.reviewed / stats.shown) * 100) : null;

    return (
        <div className="border border-card-line p-3 space-y-3" data-testid="admin-review-home-prompt">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink">Home review prompt &amp; similar events</span>
            {!ratingsEnabled && (
                <div className="flex items-center justify-between gap-2 text-[10px] text-ink-soft bg-canvas border border-line p-2">
                    <span>Requires the Show ratings feature flag.</span>
                    {onOpenFeatureFlags && (
                        <button type="button" onClick={onOpenFeatureFlags} className="text-action hover:underline whitespace-nowrap">
                            Open feature flags
                        </button>
                    )}
                </div>
            )}
            {TOGGLES.map((t) => (
                <div key={t.key} className="flex items-center justify-between gap-3">
                    <div>
                        <span className="text-[11px] font-medium text-ink">{t.label}</span>
                        <p className="text-[10px] text-muted">{t.help}</p>
                    </div>
                    <button
                        onClick={() => toggle(t)}
                        aria-label={`Toggle ${t.label}`}
                        aria-pressed={toggles[t.key]}
                        // eslint-disable-next-line no-restricted-syntax -- toggle switch is circular by design
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${toggles[t.key] ? 'bg-success' : 'bg-gray-300'}`}
                    >
                        {/* eslint-disable-next-line no-restricted-syntax -- toggle knob is circular by design */}
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-surface transition ${toggles[t.key] ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                </div>
            ))}
            {INT_FIELDS.map((field) => (
                <div key={field.key} className="flex items-center justify-between border-t border-card-line pt-2.5">
                    <div>
                        <span className="text-[11px] font-medium text-ink">{field.label}</span>
                        <p className="text-[10px] text-muted">{field.help} (1–{field.max})</p>
                    </div>
                    <input
                        type="number"
                        min={1}
                        max={field.max}
                        value={values[field.key]}
                        onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: Number(e.target.value) }))}
                        onBlur={(e) => save(field, Number(e.target.value))}
                        onKeyDown={(e) => e.key === 'Enter' && save(field, values[field.key])}
                        className="w-16 text-right text-[11px] border border-line px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-success"
                        aria-label={field.label}
                    />
                </div>
            ))}
            <div className="border-t border-card-line pt-2.5 space-y-1.5">
                <span className="text-[11px] font-medium text-ink">Last 30 days</span>
                {stats ? (
                    <>
                        <p className="text-[11px] text-ink-soft">
                            Shown {stats.shown} · dismissed {stats.dismissed} · reviewed {stats.reviewed}
                            {conversion != null && ` (${conversion}%)`} · forced {stats.forced_shown} shown / {stats.forced_reviewed} reviewed
                        </p>
                        {stats.reviews_by_entry_point.length > 0 && (
                            <ul className="text-[10px] text-ink-soft">
                                {stats.reviews_by_entry_point.map((row) => (
                                    <li key={row.key} className="flex justify-between">
                                        <span>{ENTRY_POINT_LABELS[row.key] ?? row.key}</span>
                                        <span className="tabular-nums">{row.count}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className="text-[10px] text-muted">
                            &ldquo;Reviewed&rdquo; counts prompted events reviewed from any surface; the list shows where new reviews came from.
                        </p>
                    </>
                ) : (
                    <p className="text-[10px] text-muted">No stats yet.</p>
                )}
            </div>
        </div>
    );
}
