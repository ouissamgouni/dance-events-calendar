import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    fetchNotifications,
    approveFollowRequest,
    declineFollowRequest,
    type NotificationItem,
    type NotificationKind,
} from '../api';
import { useNotifications } from '../context/NotificationsContext';

/** The six user-triggered notification kinds shown on the Tribe > Activity
 * feed. System kinds (reminders, alerts, promos, milestones) are excluded. */
const SOCIAL_KINDS: NotificationKind[] = [
    'subscription_going',
    'subscription_suggested',
    'new_follower',
    'new_friend',
    'follow_request',
    'follow_request_approved',
];

/**
 * Notification feed page.
 *
 * Lists the viewer's in-app notifications (subscription_going +
 * subscription_suggested) with a kind filter and "mark all read" action.
 * Kept intentionally simple — no infinite scroll, no realtime — because
 * the bell + this page already round-trip the unread state and the
 * underlying volume is low (one row per subscriber-event pair).
 */
export default function NotificationsPage({ socialOnly = false }: { socialOnly?: boolean } = {}) {
    const { markRead, markAllRead, markSeen } = useNotifications();
    const [items, setItems] = useState<NotificationItem[] | null>(null);
    const [unreadCount, setUnreadCount] = useState<number>(0);
    const [filterKind, setFilterKind] = useState<'all' | NotificationKind>('all');
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [busyAll, setBusyAll] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetchNotifications({
                kind: filterKind === 'all' ? undefined : filterKind,
                limit: 50,
            });
            const now = new Date().toISOString();
            // On the social Activity feed, hide system kinds (reminders,
            // alerts, promos, milestones) when no specific kind is selected.
            const filtered =
                socialOnly && filterKind === 'all'
                    ? res.items.filter((n) => SOCIAL_KINDS.includes(n.kind))
                    : res.items;
            // Visiting the page acknowledges the queue: rows render as
            // already read, mirroring how Instagram/Facebook treat
            // "viewed" as "read" (mark-all-read is fired alongside below).
            setItems(filtered.map((n) => (n.read_at ? n : { ...n, read_at: now })));
            setUnreadCount(0);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load notifications');
        }
    }, [filterKind, socialOnly]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        markSeen();
        markAllRead();
    }, [markSeen, markAllRead]);

    const handleMarkOne = async (id: number) => {
        setBusyId(id);
        try {
            await markRead(id);
            const now = new Date().toISOString();
            setItems((prev) =>
                prev
                    ? prev.map((n) =>
                        n.id === id ? { ...n, read_at: n.read_at ?? now } : n,
                    )
                    : prev,
            );
            setUnreadCount((c) => Math.max(0, c - 1));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to mark read');
        } finally {
            setBusyId(null);
        }
    };

    const handleMarkAll = async () => {
        setBusyAll(true);
        try {
            await markAllRead();
            const now = new Date().toISOString();
            setItems((prev) =>
                prev ? prev.map((n) => (n.read_at ? n : { ...n, read_at: now })) : prev,
            );
            setUnreadCount(0);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to mark all read');
        } finally {
            setBusyAll(false);
        }
    };

    return (
        <div className="max-w-2xl mx-auto px-4 py-6">
            {!socialOnly && (
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-lg font-semibold text-slate-900">
                        Notifications
                        {unreadCount > 0 && (
                            <span className="ml-2 text-xs text-slate-500 font-normal">
                                ({unreadCount} unread)
                            </span>
                        )}
                    </h1>
                    <button
                        type="button"
                        onClick={handleMarkAll}
                        disabled={busyAll || unreadCount === 0}
                        className="text-xs text-blue-600 hover:text-blue-700 disabled:text-slate-400 disabled:cursor-not-allowed"
                    >
                        {busyAll ? 'Marking…' : 'Mark all read'}
                    </button>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
                <KindChip
                    label="All"
                    active={filterKind === 'all'}
                    onClick={() => setFilterKind('all')}
                />
                <KindChip
                    label="Going"
                    active={filterKind === 'subscription_going'}
                    onClick={() => setFilterKind('subscription_going')}
                />
                <KindChip
                    label="Suggested"
                    active={filterKind === 'subscription_suggested'}
                    onClick={() => setFilterKind('subscription_suggested')}
                />
                <KindChip
                    label="Followers"
                    active={filterKind === 'new_follower'}
                    onClick={() => setFilterKind('new_follower')}
                />
                <KindChip
                    label="Friends"
                    active={filterKind === 'new_friend'}
                    onClick={() => setFilterKind('new_friend')}
                />
                <KindChip
                    label="Requests"
                    active={filterKind === 'follow_request'}
                    onClick={() => setFilterKind('follow_request')}
                />
                {!socialOnly && (
                    <>
                        <KindChip
                            label="Reminders"
                            active={filterKind === 'event_reminder'}
                            onClick={() => setFilterKind('event_reminder')}
                        />
                        <KindChip
                            label="Alerts"
                            active={filterKind === 'interest_event'}
                            onClick={() => setFilterKind('interest_event')}
                        />
                    </>
                )}
            </div>

            {error && (
                <div className="mb-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </div>
            )}

            {items === null ? (
                <p className="text-sm text-slate-400">Loading…</p>
            ) : items.length === 0 ? (
                <p className="text-sm text-slate-500">
                    No notifications yet.
                </p>
            ) : (
                <ul className="divide-y divide-slate-100 border border-slate-200 bg-white">
                    {items.map((n) => (
                        <NotificationRow
                            key={n.id}
                            item={n}
                            busy={busyId === n.id}
                            onMarkRead={() => handleMarkOne(n.id)}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}

function KindChip({
    label,
    active,
    onClick,
}: {
    label: string;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={
                active
                    ? 'px-3 py-1.5 border border-blue-500 bg-blue-500 text-white'
                    : 'px-3 py-1.5 border border-slate-200 bg-white text-slate-600 hover:border-blue-500 hover:text-blue-500'
            }
        >
            {label}
        </button>
    );
}

function NotificationRow({
    item,
    busy,
    onMarkRead,
}: {
    item: NotificationItem;
    busy: boolean;
    onMarkRead: () => void;
}) {
    const navigate = useNavigate();
    const isUnread = !item.read_at;
    const isFollowKind = item.kind === 'new_follower' || item.kind === 'new_friend' || item.kind === 'follow_request' || item.kind === 'follow_request_approved';
    const [requestHandled, setRequestHandled] = useState<'approved' | 'declined' | null>(null);
    const [requestBusy, setRequestBusy] = useState(false);
    const handleApprove = async (e: React.MouseEvent) => {
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
    const handleDecline = async (e: React.MouseEvent) => {
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
    const verb =
        item.kind === 'subscription_going'
            ? (item.also_going ? 'are going to' : 'is going to')
            : item.kind === 'subscription_review'
                ? 'reviewed'
                : item.kind === 'subscription_milestone'
                    ? (item.context ? `reached a milestone: ${item.context}` : 'reached a new milestone')
                    : item.kind === 'subscription_suggested'
                        ? 'added'
                        : item.kind === 'new_follower'
                            ? 'started following you'
                            : item.kind === 'new_friend'
                                ? 'and you are now friends!'
                                : item.kind === 'follow_request'
                                    ? 'wants to follow you'
                                    : item.kind === 'follow_request_approved'
                                        ? 'approved your follow request'
                                        : 'updated';
    const isAnonReview = item.kind === 'subscription_review' && item.context === 'anon';
    const actorName = isAnonReview
        ? 'Someone'
        : item.actor.display_name || `@${item.actor.handle}`;
    const noEventSuffix = isFollowKind || item.kind === 'subscription_milestone';
    const initial = (actorName || '?').trim().charAt(0).toUpperCase();
    const destination = (isFollowKind || item.kind === 'subscription_milestone') ? `/u/${item.actor.handle}` : `/event/${item.event_id}`;
    if (item.kind === 'interest_event') {
        const label = item.context || 'your saved search';
        return (
            <li
                className={`flex items-start gap-3 px-3 py-3 ${isUnread ? 'bg-blue-50/40' : 'bg-white'}`}
            >
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center" aria-hidden="true">
                    ✨
                </div>
                <button
                    type="button"
                    onClick={() => {
                        if (isUnread) onMarkRead();
                        navigate(`/event/${item.event_id}`);
                    }}
                    className="min-w-0 flex-1 text-left"
                >
                    <p className="text-sm text-slate-700">
                        <span className="font-medium text-slate-900">
                            {item.event_title || 'An event'}
                        </span>{' '}
                        <span className="text-slate-500">matched your {label} alert</span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                        {formatRelative(item.created_at)} ·{' '}
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
                    </p>
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
    if (item.kind === 'event_reminder') {
        const startLabel = item.event_start
            ? new Date(item.event_start).toLocaleString([], {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
            })
            : null;
        return (
            <li
                className={`flex items-start gap-3 px-3 py-3 ${isUnread ? 'bg-blue-50/40' : 'bg-white'}`}
            >
                <div className="w-8 h-8 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center" aria-hidden="true">
                    🕒
                </div>
                <button
                    type="button"
                    onClick={() => {
                        if (isUnread) onMarkRead();
                        navigate(`/event/${item.event_id}`);
                    }}
                    className="min-w-0 flex-1 text-left"
                >
                    <p className="text-sm text-slate-700">
                        <span className="text-slate-500">Reminder — you're going to</span>{' '}
                        <span className="font-medium text-slate-900">
                            {item.event_title || 'an event'}
                        </span>
                    </p>
                    {startLabel && (
                        <p className="text-xs text-rose-600 mt-0.5">Starts {startLabel}</p>
                    )}
                    <p className="text-xs text-slate-400 mt-0.5">
                        {formatRelative(item.created_at)}
                    </p>
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
    if (item.kind === 'event_review_prompt') {
        return (
            <li
                className={`flex items-start gap-3 px-3 py-3 ${isUnread ? 'bg-blue-50/40' : 'bg-white'}`}
            >
                <div className="w-8 h-8 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center" aria-hidden="true">
                    ⭐
                </div>
                <button
                    type="button"
                    onClick={() => {
                        if (isUnread) onMarkRead();
                        navigate(`/event/${item.event_id}/review`);
                    }}
                    className="min-w-0 flex-1 text-left"
                >
                    <p className="text-sm text-slate-700">
                        {item.context ? (
                            <span className="text-slate-500"><span className="font-medium text-slate-700">{item.context}</span> shared their experience at</span>
                        ) : (
                            <span className="text-slate-500">How was it? Rate your experience at</span>
                        )}{' '}
                        <span className="font-medium text-slate-900">
                            {item.event_title || 'an event'}
                        </span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                        {formatRelative(item.created_at)}
                    </p>
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
    return (
        <li
            className={`flex items-start gap-3 px-3 py-3 ${isUnread ? 'bg-blue-50/40' : 'bg-white'}`}
        >
            {item.actor.avatar_url ? (
                <img
                    src={item.actor.avatar_url}
                    alt=""
                    className="w-8 h-8 rounded-full object-cover bg-slate-100"
                />
            ) : (
                <div className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center font-semibold text-sm">
                    {initial}
                </div>
            )}
            <button
                type="button"
                onClick={() => {
                    if (isUnread) onMarkRead();
                    navigate(destination);
                }}
                className="min-w-0 flex-1 text-left"
            >
                <p className="text-xs text-slate-700">
                    <span className="font-medium text-slate-900">
                        {item.kind === 'subscription_going' && item.also_going ? `You and ${actorName}` : actorName}
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
                <p className="text-xs text-slate-400 mt-0.5">
                    {formatRelative(item.created_at)}
                </p>
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

function formatRelative(iso: string): string {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diffSec = Math.max(0, Math.round((now - then) / 1000));
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
}
