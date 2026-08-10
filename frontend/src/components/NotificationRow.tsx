import { useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    approveFollowRequest,
    declineFollowRequest,
    followUser,
    type NotificationItem,
} from '../api';
import {
    formatRelative,
    getNotificationVerb,
    hasEventSuffix,
    resolveNotificationDestination,
} from '../utils/notificationRender';

type Variant = 'page' | 'panel';

/**
 * Single source of truth for rendering one notification.
 *
 * Both the full-page feed (`/notifications`, `/tribe/activity`) and the bell
 * dropdown panel render rows through this component so new kinds, pills, and
 * copy stay in sync. `variant` only drives layout/sizing differences:
 *   - `page`: row is a flex `<li>` with a trailing "Mark read" control; the
 *     component owns navigation (marks read, then routes).
 *   - `panel`: the whole row is one clickable `<button>` (`onClick`) with a
 *     compact unread dot; navigation is delegated to the caller.
 */
export default function NotificationRow({
    item,
    variant,
    busy = false,
    onMarkRead,
    onClick,
    onFollowedBack,
}: {
    item: NotificationItem;
    variant: Variant;
    busy?: boolean;
    onMarkRead?: () => void;
    onClick?: () => void;
    onFollowedBack?: (handle: string) => void;
}) {
    const navigate = useNavigate();
    const isPanel = variant === 'panel';
    const isUnread = !item.read_at;
    const destination = resolveNotificationDestination(item);

    const [requestHandled, setRequestHandled] = useState<'approved' | 'declined' | null>(null);
    const [requestBusy, setRequestBusy] = useState(false);
    const [following, setFollowing] = useState<boolean>(Boolean(item.actor.is_following));
    const [followBusy, setFollowBusy] = useState(false);

    const handleNavigate = () => {
        if (isPanel) {
            onClick?.();
            return;
        }
        if (isUnread) onMarkRead?.();
        navigate(destination);
    };

    const handleApprove = async (e: MouseEvent) => {
        e.stopPropagation();
        if (requestBusy) return;
        setRequestBusy(true);
        try {
            await approveFollowRequest(item.actor.handle);
            setRequestHandled('approved');
            window.dispatchEvent(new Event('network:changed'));
        } finally {
            setRequestBusy(false);
        }
    };
    const handleDecline = async (e: MouseEvent) => {
        e.stopPropagation();
        if (requestBusy) return;
        setRequestBusy(true);
        try {
            await declineFollowRequest(item.actor.handle);
            setRequestHandled('declined');
            window.dispatchEvent(new Event('network:changed'));
        } finally {
            setRequestBusy(false);
        }
    };
    const handleFollowBack = async (e: MouseEvent) => {
        e.stopPropagation();
        if (followBusy || following) return;
        setFollowBusy(true);
        // Optimistic flip — keep the row visible so the pill swap is observable.
        setFollowing(true);
        try {
            await followUser(item.actor.handle);
            onFollowedBack?.(item.actor.handle);
        } catch {
            setFollowing(false);
        } finally {
            setFollowBusy(false);
        }
    };

    const verb = getNotificationVerb(item);
    const isAnonReview = item.kind === 'subscription_review' && item.context === 'anon';
    const actorName = isAnonReview
        ? 'Someone'
        : item.actor.display_name || `@${item.actor.handle}`;
    const initial = (actorName || '?').trim().charAt(0).toUpperCase();
    const noEventSuffix = !hasEventSuffix(item);
    const showFollowBack = item.kind === 'new_follower' && !item.actor.is_following;

    // Variant style tokens.
    const iconSize = isPanel ? 'w-8 h-8 sm:w-7 sm:h-7 shrink-0' : 'w-8 h-8';
    const specialTitle = isPanel
        ? 'text-xs text-slate-700 truncate'
        : 'text-sm text-slate-700';
    const defaultTitle = isPanel ? 'text-xs text-slate-700 truncate' : 'text-xs text-slate-700';
    const timeClass = isPanel
        ? 'text-[10px] text-slate-400 mt-0.5'
        : 'text-xs text-slate-400 mt-0.5';
    const subLabelSize = isPanel ? 'text-[11px]' : 'text-xs';
    const descClass = isPanel
        ? 'text-[10px] text-slate-500 mt-0.5'
        : 'text-xs text-slate-500 mt-0.5';

    const iconCircle = (extra: string, glyph: string): ReactNode => (
        <div
            // eslint-disable-next-line no-restricted-syntax -- circular icon badge (allowed exception per frontend rules)
            className={`${iconSize} rounded-full flex items-center justify-center ${extra}`}
            aria-hidden="true"
        >
            {glyph}
        </div>
    );

    let icon: ReactNode;
    let body: ReactNode;

    if (item.kind === 'interest_event') {
        const label = item.context || 'your saved search';
        icon = iconCircle('bg-blue-100 text-blue-600', '✨');
        body = (
            <>
                <p className={specialTitle}>
                    <span className="font-medium text-slate-900">
                        {item.event_title || 'An event'}
                    </span>{' '}
                    <span className="text-slate-500">matched your {label} alert</span>
                </p>
                <p className={timeClass}>
                    {formatRelative(item.created_at)}
                    {!isPanel && (
                        <>
                            {' '}·{' '}
                            <span
                                role="link"
                                tabIndex={0}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    navigate('/account#notifications');
                                }}
                                className="text-blue-600 hover:text-blue-700"
                            >
                                Manage alerts
                            </span>
                        </>
                    )}
                </p>
            </>
        );
    } else if (item.kind === 'event_reminder') {
        const startLabel = item.event_start
            ? new Date(item.event_start).toLocaleString([], {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
            })
            : null;
        icon = iconCircle('bg-rose-100 text-rose-600', '🕒');
        body = (
            <>
                <p className={specialTitle}>
                    <span className="text-slate-500">Reminder — you're going to</span>{' '}
                    <span className="font-medium text-slate-900">
                        {item.event_title || 'an event'}
                    </span>
                </p>
                {startLabel && (
                    <p className={`${subLabelSize} text-rose-600 mt-0.5`}>Starts {startLabel}</p>
                )}
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else if (item.kind === 'promo_code_added') {
        icon = iconCircle('bg-amber-100 text-amber-600', '🏷️');
        body = (
            <>
                <p className={specialTitle}>
                    <span className="text-slate-500">Promo code added —</span>{' '}
                    <span className="font-medium text-slate-900">
                        {item.event_title || 'an event'}
                    </span>
                </p>
                {item.context && (
                    <p className={`${subLabelSize} text-amber-600 mt-0.5`}>Code: {item.context}</p>
                )}
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else if (item.kind === 'event_review_prompt') {
        icon = iconCircle('bg-violet-100 text-violet-600', '⭐');
        body = (
            <>
                <p className={specialTitle}>
                    {item.context ? (
                        <span className="text-slate-500">
                            <span className="font-medium text-slate-700">{item.context}</span>{' '}
                            shared their experience at
                        </span>
                    ) : (
                        <span className="text-slate-500">How was it? Rate your experience at</span>
                    )}{' '}
                    <span className="font-medium text-slate-900">
                        {item.event_title || 'an event'}
                    </span>
                </p>
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else if (item.kind === 'milestone_unlocked') {
        icon = iconCircle('bg-amber-100 text-amber-600', '🏆');
        body = (
            <>
                <p className={specialTitle}>
                    <span className="text-slate-500">Milestone unlocked —</span>{' '}
                    <span className="font-medium text-slate-900">
                        {item.context || 'a new achievement'}
                    </span>
                </p>
                {item.description && <p className={descClass}>{item.description}</p>}
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else {
        icon = item.actor.avatar_url ? (
            <img
                src={item.actor.avatar_url}
                alt=""
                // eslint-disable-next-line no-restricted-syntax -- avatar (allowed exception per frontend rules)
                className={`${iconSize} rounded-full object-cover bg-slate-100`}
            />
        ) : (
            <div
                // eslint-disable-next-line no-restricted-syntax -- avatar placeholder (allowed exception per frontend rules)
                className={`${iconSize} rounded-full bg-slate-200 text-slate-600 flex items-center justify-center font-semibold ${isPanel ? 'text-xs' : 'text-sm'}`}
            >
                {initial}
            </div>
        );
        body = (
            <>
                <p className={defaultTitle}>
                    <span className="font-medium text-slate-900">
                        {item.kind === 'subscription_going' && item.also_going
                            ? `You and ${actorName}`
                            : actorName}
                    </span>
                    {item.actor.is_verified_organizer && (
                        <img
                            src="/orga.png"
                            alt=""
                            title="Verified organizer"
                            aria-label="Verified organizer"
                            className="inline-block w-3.5 h-3.5 ml-1 align-middle object-contain"
                        />
                    )}{' '}
                    <span className="text-slate-500">{verb}</span>
                    {!noEventSuffix && (
                        <>
                            {' '}
                            <span className="font-medium text-slate-900">
                                {item.event_title || 'an event'}
                            </span>
                        </>
                    )}
                </p>
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
                {showFollowBack && (
                    <div className="mt-2">
                        {following ? (
                            <span className="inline-block px-2 py-1 text-[11px] border border-slate-200 bg-white text-slate-600">
                                ✓ Following
                            </span>
                        ) : (
                            <button
                                type="button"
                                onClick={handleFollowBack}
                                disabled={followBusy}
                                className="px-2 py-1 text-[11px] bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60"
                            >
                                {followBusy ? 'Following…' : 'Follow back'}
                            </button>
                        )}
                    </div>
                )}
                {item.kind === 'follow_request' && (
                    <div className="mt-2 flex gap-2">
                        {requestHandled === 'approved' ? (
                            <span className="inline-block px-2 py-1 text-[11px] border border-slate-200 bg-white text-slate-600">
                                ✓ Approved
                            </span>
                        ) : requestHandled === 'declined' ? (
                            <span className="inline-block px-2 py-1 text-[11px] border border-slate-200 bg-white text-slate-600">
                                Declined
                            </span>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={handleApprove}
                                    disabled={requestBusy}
                                    className="px-2 py-1 text-[11px] bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60"
                                >
                                    {requestBusy ? '…' : 'Approve'}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDecline}
                                    disabled={requestBusy}
                                    className="px-2 py-1 text-[11px] border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                                >
                                    Decline
                                </button>
                            </>
                        )}
                    </div>
                )}
            </>
        );
    }

    if (isPanel) {
        return (
            <li>
                <button
                    type="button"
                    onClick={handleNavigate}
                    className={`w-full text-left flex items-start gap-3 px-4 py-3 sm:px-3 sm:py-2 hover:bg-slate-50 ${isUnread ? 'bg-blue-50/40' : 'bg-white'}`}
                >
                    {icon}
                    <div className="min-w-0 flex-1">{body}</div>
                    {isUnread && (
                        <span
                            // eslint-disable-next-line no-restricted-syntax -- small unread status dot (allowed exception per frontend rules)
                            className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"
                            aria-label="Unread"
                        />
                    )}
                </button>
            </li>
        );
    }

    return (
        <li
            className={`flex items-start gap-3 px-3 py-3 ${isUnread ? 'bg-blue-50/40' : 'bg-white'}`}
        >
            {icon}
            <button
                type="button"
                onClick={handleNavigate}
                className="min-w-0 flex-1 text-left"
            >
                {body}
            </button>
            {isUnread ? (
                <button
                    type="button"
                    onClick={onMarkRead}
                    disabled={busy}
                    className="shrink-0 text-xs text-slate-500 hover:text-blue-600 disabled:opacity-50"
                >
                    {busy ? '…' : 'Mark read'}
                </button>
            ) : (
                <span
                    className="shrink-0 text-xs text-slate-300"
                    aria-label="Read"
                    title="Read"
                >
                    ●
                </span>
            )}
        </li>
    );
}
