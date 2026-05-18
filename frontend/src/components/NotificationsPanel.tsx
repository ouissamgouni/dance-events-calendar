import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchNotifications, followUser, type NotificationItem } from '../api';
import { useNotifications } from '../context/NotificationsContext';

/**
 * Slide-in side panel triggered by the header bell.
 *
 * Industry-standard pattern (Slack, GitHub, Twitter): bell opens a quick
 * triage drawer; "See all" links to a full /notifications page.
 *
 * Mark-as-read semantics:
 *   - Opening the panel marks all currently-loaded rows as "seen" (clears
 *     the bell badge).
 *   - Clicking a row marks it read and navigates to the event.
 *   - Explicit "Mark all read" header action available.
 */
export default function NotificationsPanel({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const { markRead, markAllRead, markSeen, refreshUnreadCount } = useNotifications();
    const [items, setItems] = useState<NotificationItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetchNotifications({ limit: 20 });
            setItems(res.items);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        load();
        // Opening the panel = the user has acknowledged all currently
        // queued notifications (badge clears) but individual rows stay
        // unread until clicked.
        markSeen();
    }, [open, load, markSeen]);

    // Close on Escape for keyboard a11y.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const handleRowClick = async (item: NotificationItem) => {
        if (!item.read_at) {
            // Optimistic local update so the row dot disappears even if
            // the user navigates away before the request resolves.
            setItems((prev) =>
                prev
                    ? prev.map((n) =>
                        n.id === item.id
                            ? { ...n, read_at: new Date().toISOString() }
                            : n,
                    )
                    : prev,
            );
            await markRead(item.id);
        }
        onClose();
        if (item.kind === 'new_follower' || item.kind === 'new_friend') {
            navigate(`/u/${item.actor.handle}`);
        } else {
            navigate(`/event/${item.event_id}`);
        }
    };

    const handleMarkAll = async () => {
        const now = new Date().toISOString();
        setItems((prev) =>
            prev ? prev.map((n) => (n.read_at ? n : { ...n, read_at: now })) : prev,
        );
        await markAllRead();
        await refreshUnreadCount();
    };

    if (!open) return null;

    return (
        /*
         * Layout strategy:
         *   Mobile  (<sm): column — scrim on top (flex-1), panel anchored
         *           to the bottom as a bottom sheet (h-[80vh]).
         *   Desktop (≥sm): row — scrim on the left (flex-1), panel slides
         *           in from the right (h-full, max-w-sm).
         */
        <div className="fixed inset-0 z-50 flex flex-col sm:flex-row">
            {/* Scrim */}
            <button
                type="button"
                aria-label="Close notifications"
                onClick={onClose}
                className="flex-1 bg-black/40"
            />
            {/* Panel */}
            <aside
                role="dialog"
                aria-label="Notifications"
                aria-modal="true"
                className="w-full sm:max-w-sm h-[80vh] sm:h-full bg-white shadow-xl flex flex-col animate-slide-up sm:animate-slide-right"
            >
                {/* Drag handle — mobile only visual affordance */}
                <div className="sm:hidden flex justify-center pt-2 pb-1 shrink-0">
                    <div className="h-1 w-10 bg-slate-300" />
                </div>

                <div className="flex items-center justify-between px-4 py-3 sm:px-3 sm:py-2 border-b border-slate-200 shrink-0">
                    <h2 className="text-sm font-semibold text-slate-900">
                        Notifications
                    </h2>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={handleMarkAll}
                            className="text-xs text-blue-600 hover:text-blue-700"
                        >
                            Mark all read
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close"
                            className="text-slate-400 hover:text-slate-600 text-xl leading-none p-1"
                        >
                            ×
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto overscroll-contain">
                    {error ? (
                        <div className="px-4 py-3 text-xs text-red-600">{error}</div>
                    ) : items === null ? (
                        <p className="px-4 py-3 text-xs text-slate-400">Loading…</p>
                    ) : items.length === 0 ? (
                        <p className="px-4 py-6 text-xs text-slate-500 text-center">
                            No notifications yet.
                        </p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {items.map((n) => (
                                <NotificationRow
                                    key={n.id}
                                    item={n}
                                    onClick={() => handleRowClick(n)}
                                    onFollowedBack={(handle) => {
                                        setItems((prev) =>
                                            prev
                                                ? prev.map((row) =>
                                                    row.actor.handle === handle
                                                        ? {
                                                            ...row,
                                                            actor: { ...row.actor, is_following: true },
                                                        }
                                                        : row,
                                                )
                                                : prev,
                                        );
                                        // Let mounted NetworkPanel / friend-count consumers refresh.
                                        window.dispatchEvent(new CustomEvent('network:changed'));
                                    }}
                                />
                            ))}
                        </ul>
                    )}
                </div>

                {/* Safe-area padding keeps footer clear of the iOS home indicator */}
                <div
                    className="border-t border-slate-200 px-4 py-3 sm:px-3 sm:py-2 text-center shrink-0"
                    style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
                >
                    <Link
                        to="/notifications"
                        onClick={onClose}
                        className="text-xs text-blue-600 hover:text-blue-700"
                    >
                        See all notifications →
                    </Link>
                </div>
            </aside>
        </div>
    );
}

function NotificationRow({
    item,
    onClick,
    onFollowedBack,
}: {
    item: NotificationItem;
    onClick: () => void;
    onFollowedBack?: (handle: string) => void;
}) {
    const isUnread = !item.read_at;
    const isFollowKind = item.kind === 'new_follower' || item.kind === 'new_friend';
    // Phase E (E1): inline Follow-back CTA on new_follower rows when the
    // viewer does not already follow the actor. ``new_friend`` rows mean
    // the relationship is already mutual, so no CTA is needed.
    const showFollowBack =
        item.kind === 'new_follower' && !item.actor.is_following;
    const [following, setFollowing] = useState<boolean>(
        Boolean(item.actor.is_following),
    );
    const [busy, setBusy] = useState(false);
    const handleFollowBack = async (e: MouseEvent) => {
        e.stopPropagation();
        if (busy || following) return;
        setBusy(true);
        // Optimistic flip — keep the row visible (don't navigate) so the
        // pill swap is immediately observable to the user.
        setFollowing(true);
        try {
            await followUser(item.actor.handle);
            onFollowedBack?.(item.actor.handle);
        } catch {
            setFollowing(false);
        } finally {
            setBusy(false);
        }
    };
    const verb =
        item.kind === 'subscription_going'
            ? 'is going to'
            : item.kind === 'subscription_suggested'
                ? 'added'
                : item.kind === 'new_follower'
                    ? 'started following you'
                    : item.kind === 'new_friend'
                        ? 'and you are now friends!'
                        : 'updated';
    const actorName = item.actor.display_name || `@${item.actor.handle}`;
    const initial = (actorName || '?').trim().charAt(0).toUpperCase();
    return (
        <li>
            <button
                type="button"
                onClick={onClick}
                className={`w-full text-left flex items-start gap-3 px-4 py-3 sm:px-3 sm:py-2 hover:bg-slate-50 ${isUnread ? 'bg-blue-50/40' : 'bg-white'}`}
            >
                {item.actor.avatar_url ? (
                    <img
                        src={item.actor.avatar_url}
                        alt=""
                        className="w-8 h-8 sm:w-7 sm:h-7 rounded-full object-cover bg-slate-100 shrink-0"
                    />
                ) : (
                    <div className="w-8 h-8 sm:w-7 sm:h-7 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center font-semibold text-xs shrink-0">
                        {initial}
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <p className="text-xs text-slate-700 truncate">
                        <span className="font-medium text-slate-900">{actorName}</span>{' '}
                        <span className="text-slate-500">{verb}</span>
                        {!isFollowKind && (
                            <>
                                {' '}
                                <span className="font-medium text-slate-900">
                                    {item.event_title || 'an event'}
                                </span>
                            </>
                        )}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                        {formatRelative(item.created_at)}
                    </p>
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
                                    disabled={busy}
                                    className="px-2 py-1 text-[11px] bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60"
                                >
                                    {busy ? 'Following…' : 'Follow back'}
                                </button>
                            )}
                        </div>
                    )}
                </div>
                {isUnread && (
                    <span
                        className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"
                        aria-label="Unread"
                    />
                )}
            </button>
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
