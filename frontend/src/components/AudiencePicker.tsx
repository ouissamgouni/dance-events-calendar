import type { ShareAudience } from '../api';
import { useAuth } from '../context/AuthContext';

/**
 * 3-tier audience selector used everywhere a user picks who can see
 * something they did (RSVP, save, default sharing preference).
 *
 * Renders an icon segmented control: 🌐 Public / 👥 Friends / 🔒 Private.
 * Friends = mutual followers. Private = only me.
 *
 * Pure / controlled — the parent owns persistence and optimistic state.
 *
 * Phase E (E2): when the user picks ``friends`` and their own
 * ``friend_count == 0``, render an inline hint pointing to the network
 * panel so they understand the audience is currently empty.
 */

const OPTIONS: { value: ShareAudience; icon: string; label: string; help: string }[] = [
    { value: 'public', icon: '🌐', label: 'Public', help: 'Anyone can see' },
    { value: 'friends', icon: '👥', label: 'Friends', help: 'Mutual followers only' },
    { value: 'private', icon: '🔒', label: 'Private', help: 'Only me' },
];

export interface AudiencePickerProps {
    value: ShareAudience;
    onChange: (next: ShareAudience) => void;
    /** Optional override of available tiers (e.g. drop "public" in some flows). */
    options?: ShareAudience[];
    disabled?: boolean;
    /** Compact = icon-only buttons; full = icon + label. Default: 'compact'. */
    size?: 'compact' | 'full';
    /** Optional aria-label for the group; defaults to "Audience". */
    ariaLabel?: string;
    className?: string;
}

export default function AudiencePicker({
    value,
    onChange,
    options,
    disabled,
    size = 'compact',
    ariaLabel = 'Audience',
    className,
}: AudiencePickerProps) {
    const tiers = options
        ? OPTIONS.filter((o) => options.includes(o.value))
        : OPTIONS;
    const { user } = useAuth();
    // E2: surface a hint only when the active tier is ``friends`` AND the
    // signed-in viewer has zero mutual follows. ``friend_count == undefined``
    // (older payload, anon, transient) → suppress the hint to stay safe.
    const showZeroFriendsHint =
        value === 'friends' && user != null && user.friend_count === 0;
    return (
        <div className={'inline-flex flex-col items-start ' + (className ?? '')}>
            <div
                role="radiogroup"
                aria-label={ariaLabel}
                className="inline-flex border border-slate-200"
            >
                {tiers.map((opt) => {
                    const active = value === opt.value;
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            aria-label={`${opt.label} — ${opt.help}`}
                            title={`${opt.label} — ${opt.help}`}
                            disabled={disabled}
                            onClick={() => {
                                if (!active) onClick(onChange, opt.value);
                            }}
                            className={
                                'px-2.5 py-1.5 text-xs font-medium transition border-l first:border-l-0 border-slate-200 ' +
                                (active
                                    ? 'bg-blue-500 text-white'
                                    : 'bg-white text-slate-600 hover:bg-slate-50') +
                                (disabled ? ' opacity-60 cursor-not-allowed' : '')
                            }
                        >
                            <span aria-hidden>{opt.icon}</span>
                            {size === 'full' && (
                                <span className="ml-1.5">{opt.label}</span>
                            )}
                        </button>
                    );
                })}
            </div>
            {showZeroFriendsHint && (
                <p
                    className="mt-1 text-[11px] text-slate-500"
                    data-testid="audience-zero-friends-hint"
                >
                    Visible to 0 people — you have no friends yet.{' '}
                    <a
                        href="/account#network"
                        className="text-blue-600 hover:text-blue-700 underline"
                    >
                        Find people to follow →
                    </a>
                </p>
            )}
        </div>
    );
}

function onClick(cb: (v: ShareAudience) => void, v: ShareAudience) {
    cb(v);
}
