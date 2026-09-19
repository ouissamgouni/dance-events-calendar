import { useCallback, useEffect, useState } from 'react';
import {
    Calendar,
    Inbox,
    type LucideIcon,
    MessageSquare,
    MoreHorizontal,
    Trophy,
    Users,
} from 'lucide-react';
import {
    fetchNotifications,
    type NotificationItem,
    type NotificationKind,
} from '../api';
import { useNotifications } from '../context/NotificationsContext';
import NotificationRow from '../components/NotificationRow';
import {
    notificationCategory,
    type NotificationCategory,
} from '../utils/notificationRender';

/** Category filter pills shown above the feed (page + Tribe > Activity). The
 * bell dropdown panel stays pill-free. */
const CATEGORY_PILLS: { key: 'all' | NotificationCategory; label: string; Icon: LucideIcon }[] = [
    { key: 'all', label: 'All', Icon: Inbox },
    { key: 'events', label: 'Events', Icon: Calendar },
    { key: 'network', label: 'Network', Icon: Users },
    { key: 'reviews', label: 'Reviews', Icon: MessageSquare },
    { key: 'milestones', label: 'Milestones', Icon: Trophy },
    { key: 'others', label: 'Others', Icon: MoreHorizontal },
];

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
    const [filterCategory, setFilterCategory] = useState<'all' | NotificationCategory>('all');
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [busyAll, setBusyAll] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetchNotifications({ limit: 50 });
            const now = new Date().toISOString();
            // Visiting the page acknowledges the queue: rows render as
            // already read, mirroring how Instagram/Facebook treat
            // "viewed" as "read" (mark-all-read is fired alongside below).
            setItems(res.items.map((n) => (n.read_at ? n : { ...n, read_at: now })));
            setUnreadCount(0);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load notifications');
        }
    }, []);

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

    const visibleItems = (items ?? []).filter(
        (n) =>
            (!socialOnly || SOCIAL_KINDS.includes(n.kind)) &&
            (filterCategory === 'all' || notificationCategory(n.kind) === filterCategory),
    );

    return (
        <div className="max-w-2xl mx-auto px-4 py-6">
            {!socialOnly && (
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-2xl font-bold text-ink">
                        Activity
                        {unreadCount > 0 && (
                            <span className="ml-2 text-xs text-ink-soft font-normal">
                                ({unreadCount} unread)
                            </span>
                        )}
                    </h1>
                    <button
                        type="button"
                        onClick={handleMarkAll}
                        disabled={busyAll || unreadCount === 0}
                        className="text-xs text-action hover:text-action disabled:text-muted disabled:cursor-not-allowed"
                    >
                        {busyAll ? 'Marking…' : 'Mark all read'}
                    </button>
                </div>
            )}

            <div className="flex items-center gap-2 mb-3 overflow-x-auto">
                {CATEGORY_PILLS.filter((p) => !(socialOnly && p.key === 'others')).map((p) => (
                    <CategoryPill
                        key={p.key}
                        label={p.label}
                        Icon={p.Icon}
                        active={filterCategory === p.key}
                        onClick={() => setFilterCategory(p.key)}
                    />
                ))}
            </div>

            {error && (
                <div className="mb-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">
                    {error}
                </div>
            )}

            {items === null ? (
                <p className="text-sm text-muted">Loading…</p>
            ) : visibleItems.length === 0 ? (
                <p className="text-sm text-ink-soft">
                    No notifications yet.
                </p>
            ) : (
                <ul className="divide-y divide-slate-100 border border-line bg-surface">
                    {visibleItems.map((n) => (
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

function CategoryPill({
    label,
    Icon,
    active,
    onClick,
}: {
    label: string;
    Icon: LucideIcon;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={
                active
                    ? 'flex items-center gap-1.5 px-3 py-2 border border-action/40 bg-action/10 text-action whitespace-nowrap shrink-0'
                    : 'flex items-center gap-1.5 px-3 py-2 border border-line bg-surface text-ink-soft hover:border-action hover:text-action whitespace-nowrap shrink-0'
            }
        >
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
            <span className="text-sm font-medium">{label}</span>
        </button>
    );
}
