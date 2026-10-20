import { useState } from 'react';
import { followUser } from '../api';
import type { Attendee } from '../types';

export function AttendeeAvatar({ attendee, size }: { attendee: Attendee; size: number }) {
    const name = attendee.display_name || (attendee.handle ? `@${attendee.handle}` : 'Someone');
    if (attendee.avatar_url) {
        return (
            <img
                src={attendee.avatar_url}
                alt=""
                style={{ width: size, height: size }}
                // eslint-disable-next-line no-restricted-syntax -- avatar (allowed exception per frontend rules)
                className="shrink-0 rounded-full object-cover"
            />
        );
    }
    return (
        <span
            style={{ width: size, height: size }}
            // eslint-disable-next-line no-restricted-syntax -- avatar placeholder (allowed exception per frontend rules)
            className="flex shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-ink-soft"
        >
            {name.charAt(0).toUpperCase()}
        </span>
    );
}

/** Follow / Following / Requested / Friend state pill. Sits above the card's
 *  profile link and stops propagation so tapping it never navigates. */
export default function AttendeeFollowPill({ attendee }: { attendee: Attendee }) {
    const [state, setState] = useState<'idle' | 'busy' | 'followed' | 'error'>(
        attendee.viewer_follow_status === 'approved' ? 'followed' : 'idle',
    );
    const isPending = attendee.viewer_follow_status === 'pending' && state === 'idle';

    if (attendee.is_friend) {
        return (
            <span className="relative z-10 inline-flex items-center border border-line bg-surface px-2 py-0.5 text-xs leading-none text-ink-soft">
                Friend
            </span>
        );
    }
    if (state === 'followed') {
        return (
            <span className="relative z-10 inline-flex items-center border border-line bg-surface px-2 py-0.5 text-xs leading-none text-ink-soft">
                Following
            </span>
        );
    }
    if (isPending) {
        return (
            <span className="relative z-10 inline-flex items-center border border-line bg-surface px-2 py-0.5 text-xs leading-none text-ink-soft">
                Requested
            </span>
        );
    }
    if (!attendee.handle) return null;

    const onClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (state === 'busy') return;
        setState('busy');
        try {
            await followUser(attendee.handle!);
            setState('followed');
            window.dispatchEvent(new Event('network:changed'));
        } catch {
            setState('error');
        }
    };

    return (
        <button
            type="button"
            onClick={onClick}
            disabled={state === 'busy'}
            className="relative z-10 inline-flex items-center bg-action px-2 py-0.5 text-xs leading-none text-white transition hover:opacity-90 disabled:opacity-50"
        >
            {state === 'busy' ? 'Following…' : state === 'error' ? 'Retry' : 'Follow'}
        </button>
    );
}
