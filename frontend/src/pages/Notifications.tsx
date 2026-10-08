import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
    Calendar,
    Inbox,
    type LucideIcon,
    MessageSquare,
    MoreHorizontal,
    Sparkles,
    Trophy,
    Users,
    X,
} from 'lucide-react';
import {
    fetchNotifications,
    type NotificationCategoryFilter,
    type NotificationItem,
    type NotificationKind,
} from '../api';
import { useNotifications } from '../context/NotificationsContext';
import NotificationRow from '../components/NotificationRow';
import {
    isNotificationKind,
    type NotificationCategory,
} from '../utils/notificationRender';

const PAGE_SIZE = 50;

/** Category filter pills shown above the feed (page + Tribe > Activity). The
 * bell dropdown panel stays pill-free. */
const CATEGORY_PILLS: { key: 'all' | NotificationCategory; label: string; Icon: LucideIcon }[] = [
    { key: 'all', label: 'All', Icon: Inbox },
    { key: 'plans', label: 'My plans', Icon: Calendar },
    { key: 'matches', label: 'Matches', Icon: Sparkles },
    { key: 'people', label: 'People', Icon: Users },
    { key: 'reviews', label: 'Reviews', Icon: MessageSquare },
    { key: 'milestones', label: 'Milestones', Icon: Trophy },
    { key: 'others', label: 'Others', Icon: MoreHorizontal },
];

const SOCIAL_PILLS = new Set<'all' | NotificationCategory>(['all', 'people', 'reviews', 'milestones']);

/** The friend/follow-triggered notification kinds shown on the Tribe >
 * Activity feed. System kinds (reminders, alerts, promos, personal
 * milestones) are excluded. */
const SOCIAL_KINDS: NotificationKind[] = [
    'subscription_going',
    'subscription_suggested',
    'subscription_review',
    'subscription_memories',
    'subscription_milestone',
    'plan_session_added',
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
    const [total, setTotal] = useState<number>(0);
    const [loadingMore, setLoadingMore] = useState(false);
    const [unreadCount, setUnreadCount] = useState<number>(0);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [busyAll, setBusyAll] = useState(false);
    const [searchParams, setSearchParams] = useSearchParams();
    const rawKind = searchParams.get('kind');
    const kindParam = !socialOnly && rawKind && isNotificationKind(rawKind) ? rawKind : null;
    // Push/email deep links use ?kind=interest_event; that is the Matches pill.
    const kindFilter = kindParam === 'interest_event' ? null : kindParam;
    const rawDay = searchParams.get('day');
    const dayParam =
        kindParam === 'interest_event' && rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : null;
    const [filterCategory, setFilterCategory] = useState<'all' | NotificationCategory>(
        kindParam === 'interest_event' ? 'matches' : 'all',
    );

    useEffect(() => {
        if (kindParam === 'interest_event') setFilterCategory('matches');
    }, [kindParam]);

    const category: NotificationCategoryFilter | undefined =
        filterCategory !== 'all' ? filterCategory : socialOnly ? 'social' : undefined;

    const load = useCallback(async () => {
        try {
            const res = await fetchNotifications({
                limit: PAGE_SIZE,
                kind: kindFilter ?? undefined,
                category,
                day: dayParam ?? undefined,
            });
            const now = new Date().toISOString();
            // Visiting the page acknowledges the queue: rows render as
            // already read, mirroring how Instagram/Facebook treat
            // "viewed" as "read" (mark-all-read is fired alongside below).
            setItems(res.items.map((n) => (n.read_at ? n : { ...n, read_at: now })));
            setTotal(res.total);
            setUnreadCount(0);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load notifications');
        }
    }, [kindFilter, category, dayParam]);

    const handleLoadMore = async () => {
        setLoadingMore(true);
        try {
            const res = await fetchNotifications({
                limit: PAGE_SIZE,
                offset: items?.length ?? 0,
                kind: kindFilter ?? undefined,
                category,
                day: dayParam ?? undefined,
            });
            const now = new Date().toISOString();
            setItems((prev) => [
                ...(prev ?? []),
                ...res.items.map((n) => (n.read_at ? n : { ...n, read_at: now })),
            ]);
            setTotal(res.total);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load notifications');
        } finally {
            setLoadingMore(false);
        }
    };

    const handleSelectCategory = (key: 'all' | NotificationCategory) => {
        setFilterCategory(key);
        if (rawKind === 'interest_event') {
            const next = new URLSearchParams(searchParams);
            next.delete('kind');
            next.delete('day');
            setSearchParams(next, { replace: true });
        }
    };

    const clearDay = () => {
        const next = new URLSearchParams(searchParams);
        next.delete('day');
        setSearchParams(next, { replace: true });
    };

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

    // Reviews/Milestones pills are server-filtered by category; the Tribe feed
    // additionally drops the viewer's own (non-social) kinds from them.
    const visibleItems = (items ?? []).filter(
        (n) => !socialOnly || SOCIAL_KINDS.includes(n.kind),
    );

    return (
        <div className="mx-auto max-w-3xl px-4 py-6">
            <div>
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
                    {kindFilter && (
                        <button
                            type="button"
                            onClick={() => {
                                const next = new URLSearchParams(searchParams);
                                next.delete('kind');
                                setSearchParams(next, { replace: true });
                            }}
                            className="flex items-center gap-1.5 px-3 py-2 border border-action bg-action text-white whitespace-nowrap shrink-0"
                            aria-label="Show all notifications"
                        >
                            <span className="text-sm font-medium">Filtered</span>
                            <X size={16} strokeWidth={2} aria-hidden="true" />
                        </button>
                    )}
                    {CATEGORY_PILLS.filter((p) => !socialOnly || SOCIAL_PILLS.has(p.key)).map((p) => (
                        <CategoryPill
                            key={p.key}
                            label={p.label}
                            Icon={p.Icon}
                            active={filterCategory === p.key}
                            onClick={() => handleSelectCategory(p.key)}
                        />
                    ))}
                </div>

                {filterCategory === 'matches' && !socialOnly && (
                    <div className="flex items-center justify-between gap-2 mb-3">
                        {dayParam ? (
                            <button
                                type="button"
                                onClick={clearDay}
                                className="flex items-center gap-1.5 px-3 py-1.5 border border-action bg-action text-white whitespace-nowrap"
                                aria-label="Show all matches"
                            >
                                <span className="text-sm font-medium">
                                    {new Date(`${dayParam}T00:00:00`).toLocaleDateString([], {
                                        weekday: 'short',
                                        day: 'numeric',
                                        month: 'short',
                                    })}
                                    {items !== null && ` · ${total} ${total === 1 ? 'match' : 'matches'}`}
                                </span>
                                <X size={16} strokeWidth={2} aria-hidden="true" />
                            </button>
                        ) : (
                            <span />
                        )}
                        <Link to="/saved-searches" className="text-sm text-action hover:underline">
                            Manage alerts
                        </Link>
                    </div>
                )}

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

                {items !== null && items.length < total && (
                    <div className="mt-4 flex justify-center">
                        <button
                            type="button"
                            onClick={handleLoadMore}
                            disabled={loadingMore}
                            className="px-4 py-2 text-sm border border-line bg-surface text-ink hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loadingMore ? 'Loading…' : 'Load more'}
                        </button>
                    </div>
                )}
            </div>
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
