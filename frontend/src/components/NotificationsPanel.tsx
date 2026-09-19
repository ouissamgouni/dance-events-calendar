import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchNotifications, type NotificationItem } from '../api';
import { useNotifications } from '../context/NotificationsContext';
import { resolveNotificationDestination } from '../utils/notificationRender';
import NotificationRow from './NotificationRow';

/**
 * Slide-in side panel triggered by the header bell.
 *
 * Industry-standard pattern (Slack, GitHub, Twitter): bell opens a quick
 * triage drawer; "See all" links to a full /notifications page.
 *
 * Mark-as-read semantics:
 *   - Opening the panel marks all currently-loaded rows as read (clears
 *     the bell badge and the per-row unread dots), matching the
 *     Instagram/Facebook pattern where viewing the list is itself the
 *     acknowledgement.
 *   - Clicking a row still navigates to the event (rows are already read
 *     by then, so this is a no-op on the read state).
 *   - Explicit "Mark all read" header action remains available too.
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
            const now = new Date().toISOString();
            // Opening the panel acknowledges the queue: rows render as
            // already read, mirroring how Instagram/Facebook treat
            // "viewed" as "read" (mark-all-read fires alongside below).
            setItems(res.items.map((n) => (n.read_at ? n : { ...n, read_at: now })));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        load();
        markSeen();
        markAllRead();
    }, [open, load, markSeen, markAllRead]);

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
        navigate(resolveNotificationDestination(item));
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
         *
         * z-index note: Uses z-[10000] to appear above all sticky headers
         * (e.g., MyEventsExperience's z-[7600]) and other overlays.
         */
        <div className="fixed inset-0 z-[10000] flex flex-col sm:flex-row">
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
                className="w-full sm:max-w-sm h-[80vh] sm:h-full bg-surface shadow-xl flex flex-col animate-slide-up sm:animate-slide-right"
            >
                {/* Drag handle — mobile only visual affordance */}
                <div className="sm:hidden flex justify-center pt-2 pb-1 shrink-0">
                    <div className="h-1 w-10 bg-slate-300" />
                </div>

                <div className="flex items-center justify-between px-4 py-3 sm:px-3 sm:py-2 border-b border-line shrink-0">
                    <h2 className="text-sm font-semibold text-ink">
                        Notifications
                    </h2>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={handleMarkAll}
                            className="text-xs text-action hover:text-action"
                        >
                            Mark all read
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close"
                            className="text-muted hover:text-ink-soft text-xl leading-none p-1"
                        >
                            ×
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto overscroll-contain">
                    {error ? (
                        <div className="px-4 py-3 text-xs text-danger">{error}</div>
                    ) : items === null ? (
                        <p className="px-4 py-3 text-xs text-muted">Loading…</p>
                    ) : items.length === 0 ? (
                        <p className="px-4 py-6 text-xs text-ink-soft text-center">
                            No notifications yet.
                        </p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {items.map((n) => (
                                <NotificationRow
                                    key={n.id}
                                    item={n}
                                    variant="panel"
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
                    className="border-t border-line px-4 py-3 sm:px-3 sm:py-2 text-center shrink-0"
                    style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
                >
                    <Link
                        to="/notifications"
                        onClick={onClose}
                        className="text-xs text-action hover:text-action"
                    >
                        See all notifications →
                    </Link>
                </div>
            </aside>
        </div>
    );
}
