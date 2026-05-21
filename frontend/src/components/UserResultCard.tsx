/**
 * Shared user-card primitive for search/discover surfaces.
 *
 * Two variants:
 *   - `compact`: dense row (header search, small popovers) — name + handle
 *     + small avatar + verified tick.
 *   - `rich`: full row (interest-picker, discover page) — adds friend /
 *     following badges, optional metric counts ("3 going / 1 saved"),
 *     and a slot for trailing actions (Follow CTA, pick chevron…).
 *
 * Square corners per ui-conventions; avatar is the only allowed
 * `rounded-full` exception.
 */
import { Link } from 'react-router-dom';

export interface UserCardModel {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer?: boolean;
    is_admin_managed?: boolean;
    subscribers_count?: number;
    is_friend?: boolean;
    is_followed_by_viewer?: boolean;
}

export interface UserCardMetrics {
    // Per-handle upcoming activity counts from
    // GET /api/social/users/interest-summary — already visibility-filtered.
    upcoming_going_visible?: number;
    upcoming_saved_visible?: number;
}

export interface UserResultCardProps {
    user: UserCardModel;
    metrics?: UserCardMetrics;
    variant?: 'compact' | 'rich';
    active?: boolean; // keyboard-highlighted row
    trailing?: React.ReactNode; // Follow CTA, etc.
    onSelect?: (user: UserCardModel) => void;
    href?: string; // when set, the card is a Link instead of a button
}

export default function UserResultCard({
    user,
    metrics,
    variant = 'compact',
    active = false,
    trailing,
    onSelect,
    href,
}: UserResultCardProps) {
    const isRich = variant === 'rich';
    const baseCls =
        'flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 w-full text-left ' +
        (active ? 'bg-slate-50' : '');

    const body = (
        <>
            <Avatar url={user.avatar_url} name={user.display_name || user.handle} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-slate-900 truncate">
                    <span className="truncate">
                        {user.display_name || `@${user.handle}`}
                    </span>
                    {user.is_verified_organizer && (
                        <img
                            src="/orga.png"
                            alt=""
                            title="Verified organizer"
                            aria-label="Verified organizer"
                            className="w-3.5 h-3.5 object-contain"
                        />
                    )}
                    {user.is_admin_managed && (
                        <img
                            src="/badge.png"
                            alt=""
                            title="Curator"
                            aria-label="Curator"
                            className="w-3.5 h-3.5 object-contain"
                        />
                    )}
                    {isRich && user.is_friend && (
                        <span className="ml-1 px-1 text-[10px] bg-blue-50 text-blue-700 border border-blue-200">
                            Friend
                        </span>
                    )}
                    {isRich && !user.is_friend && user.is_followed_by_viewer && (
                        <span className="ml-1 px-1 text-[10px] bg-slate-100 text-slate-600 border border-slate-200">
                            Following
                        </span>
                    )}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                    @{user.handle}
                    {typeof user.subscribers_count === 'number' && (
                        <>
                            {' · '}
                            {user.subscribers_count} subscriber
                            {user.subscribers_count === 1 ? '' : 's'}
                        </>
                    )}
                    {isRich && metrics && (
                        <>
                            {(metrics.upcoming_going_visible ?? 0) > 0 && (
                                <> · {metrics.upcoming_going_visible} going</>
                            )}
                            {(metrics.upcoming_saved_visible ?? 0) > 0 && (
                                <> · {metrics.upcoming_saved_visible} saved</>
                            )}
                        </>
                    )}
                </div>
            </div>
            {trailing && <div className="shrink-0">{trailing}</div>}
        </>
    );

    if (href) {
        return (
            <Link to={href} className={baseCls} onClick={() => onSelect?.(user)}>
                {body}
            </Link>
        );
    }
    return (
        <button
            type="button"
            className={baseCls}
            onClick={() => onSelect?.(user)}
        >
            {body}
        </button>
    );
}

function Avatar({ url, name }: { url: string | null; name: string }) {
    if (url) {
        return (
            <img
                src={url}
                alt=""
                // eslint-disable-next-line no-restricted-syntax -- avatar (allowed exception per ui-conventions)
                className="w-7 h-7 rounded-full object-cover bg-slate-100 shrink-0"
            />
        );
    }
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    return (
        // eslint-disable-next-line no-restricted-syntax -- avatar
        <div className="w-7 h-7 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-xs font-semibold shrink-0">
            {initial}
        </div>
    );
}
