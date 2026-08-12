import { useCallback, useEffect, useState } from 'react';
import {
    fetchNotifications,
    type NotificationItem,
    type NotificationKind,
} from '../api';
import { useNotifications } from '../context/NotificationsContext';
import NotificationRow from '../components/NotificationRow';

/** The friend/follow-triggered notification kinds shown on the Tribe >
 * Activity feed. System kinds (reminders, alerts, promos, personal
 * milestones) are excluded. */
const SOCIAL_KINDS: NotificationKind[] = [
    'subscription_going',
    'subscription_suggested',
    'subscription_review',
    'subscription_milestone',
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
                        <KindChip
                            label="Reviews"
                            active={filterKind === 'event_review_prompt'}
                            onClick={() => setFilterKind('event_review_prompt')}
                        />
                        <KindChip
                            label="Milestones"
                            active={filterKind === 'milestone_unlocked'}
                            onClick={() => setFilterKind('milestone_unlocked')}
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
                            variant="page"
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
