import type { NotificationChannelSettings } from '../api';

export type DeliveryChannel = keyof NotificationChannelSettings;

// Time-sensitive features: the backend never batches them into the digest.
const INSTANT_ONLY_FEATURES = new Set(['event_reminders', 'schedule_updates', 'promo_codes']);

const CHANNELS: { key: DeliveryChannel; label: string }[] = [
    { key: 'push', label: 'Push' },
    { key: 'email_instant', label: 'Email instant' },
    { key: 'email_digest', label: 'Email digest' },
];

export default function FeatureDeliveryChannels({
    feature,
    label,
    config,
    onChange,
}: {
    feature: string;
    label: string;
    config?: NotificationChannelSettings;
    onChange: (feature: string, channel: DeliveryChannel, value: boolean) => void;
}) {
    if (!config) return null;
    const instantOnly = INSTANT_ONLY_FEATURES.has(feature);
    return (
        <div className="border-t border-card-line pt-2.5 space-y-1">
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-ink">Delivery channels</span>
                {!config.email_instant && !config.email_digest && (
                    <span className="text-[10px] text-muted">Email off</span>
                )}
            </div>
            <p className="text-[10px] text-muted">
                {instantOnly
                    ? 'In-app is always on. Time-sensitive, so never batched into the digest.'
                    : 'In-app is always on. Digest email waits for the activity digest schedule.'}
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
                {CHANNELS.map((c) => {
                    const locked = c.key === 'email_digest' && instantOnly;
                    return (
                        <label
                            key={c.key}
                            className={`flex items-center gap-1 text-[10px] ${locked ? 'text-muted' : 'text-ink-soft'}`}
                            title={locked ? 'Time-sensitive: never batched into the digest' : undefined}
                        >
                            <input
                                type="checkbox"
                                aria-label={`${label} ${c.label.toLowerCase()}`}
                                checked={locked ? false : config[c.key]}
                                disabled={locked}
                                onChange={(e) => onChange(feature, c.key, e.target.checked)}
                                className="disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            {c.label}
                        </label>
                    );
                })}
            </div>
        </div>
    );
}
