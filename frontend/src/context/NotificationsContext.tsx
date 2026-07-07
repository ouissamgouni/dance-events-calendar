import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import {
    fetchNotifications,
    fetchNotificationsUnreadCount,
    markAllNotificationsRead,
    markNotificationRead,
} from '../api';
import { useToast } from '../components/Toast';

const SEEN_FRIEND_NOTIF_KEY = 'seen_friend_notification_ids';
const SEEN_FRIEND_NOTIF_MAX = 200;

function loadSeenFriendIds(): Set<number> {
    try {
        const raw = window.localStorage.getItem(SEEN_FRIEND_NOTIF_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return new Set(parsed.filter((n) => typeof n === 'number'));
    } catch {
        /* corrupt storage — reset on next save */
    }
    return new Set();
}

function persistSeenFriendIds(ids: Set<number>): void {
    try {
        // Cap retention so localStorage doesn't grow unbounded.
        const arr = Array.from(ids).slice(-SEEN_FRIEND_NOTIF_MAX);
        window.localStorage.setItem(SEEN_FRIEND_NOTIF_KEY, JSON.stringify(arr));
    } catch {
        /* quota / private mode — toast will simply re-fire next session */
    }
}

/**
 * Shared notification state for the bell + the notifications surface.
 *
 * Two distinct counters:
 *   - ``unreadCount``  — rows whose ``read_at IS NULL`` server-side. Drives
 *                       the bell badge.
 *   - ``seenAt``      — local-only timestamp of the last time the user
 *                       opened the notifications surface. The bell badge is
 *                       hidden whenever ``seenAt >= last server fetch's
 *                       latest created_at``.
 *
 * The panel and the full page both call ``markAllRead()`` as soon as they
 * are opened/mounted (in addition to ``markSeen()``), so simply viewing the
 * list marks every row read — the Instagram/Facebook pattern, rather than
 * requiring an explicit click or "Mark all read" per row. ``markRead``/
 * ``markAllRead`` remain available for the row-click and explicit button
 * interactions, which are now idempotent no-ops in the common case.
 *
 * Polls every 60s while authenticated; also refreshes on route changes so
 * mark-read interactions on the panel/page propagate to the bell without a
 * websocket.
 */

interface NotificationsContextType {
    unreadCount: number;
    /** True when the bell badge should hide (user has opened the panel
     *  more recently than the latest unread row). */
    seen: boolean;
    /** Fetch unread count from the server immediately. */
    refreshUnreadCount: () => Promise<void>;
    /** Mark a single notification read (optimistic decrement). */
    markRead: (id: number) => Promise<void>;
    /** Mark all read (optimistic zero). */
    markAllRead: () => Promise<void>;
    /** Mark the bell as "seen" — clears the badge without touching read_at. */
    markSeen: () => void;
}

const NotificationsContext = createContext<NotificationsContextType | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const location = useLocation();
    const toast = useToast();
    const [unreadCount, setUnreadCount] = useState<number>(0);
    const [seenAt, setSeenAt] = useState<number>(0);
    const [lastFetchAt, setLastFetchAt] = useState<number>(0);
    const cancelRef = useRef<boolean>(false);
    // Phase E (E6): persisted set of new_friend notification IDs the
    // viewer has already been toasted about. Loaded lazily on first poll
    // so server-side notification deletes (uncommon) don't matter — once
    // an ID is in the set we never re-fire for it.
    const seenFriendIdsRef = useRef<Set<number> | null>(null);
    // Skip the very first poll so users who land already-mutual don't
    // see a stale celebratory toast on every page load.
    const friendPollPrimedRef = useRef<boolean>(false);

    const checkNewFriendToasts = useCallback(async () => {
        if (!user) return;
        try {
            const res = await fetchNotifications({
                kind: 'new_friend',
                unreadOnly: true,
                limit: 10,
            });
            if (cancelRef.current) return;
            if (seenFriendIdsRef.current === null) {
                seenFriendIdsRef.current = loadSeenFriendIds();
            }
            const seen = seenFriendIdsRef.current;
            const fresh = res.items.filter((n) => !seen.has(n.id));
            if (fresh.length === 0) {
                friendPollPrimedRef.current = true;
                return;
            }
            // First poll of the session: prime the set silently so we
            // don't toast for pre-existing rows, then enable toasting.
            if (!friendPollPrimedRef.current) {
                fresh.forEach((n) => seen.add(n.id));
                persistSeenFriendIds(seen);
                friendPollPrimedRef.current = true;
                return;
            }
            for (const n of fresh) {
                const handle = n.actor.handle;
                const name = n.actor.display_name || `@${handle}`;
                toast.push({
                    title: `🎉 You and ${name} are now friends`,
                    message: "Their Going feed is now visible to you.",
                    variant: 'success',
                    action: handle
                        ? {
                            label: `Open @${handle}`,
                            onClick: () => {
                                window.location.assign(`/u/${handle}`);
                            },
                        }
                        : undefined,
                });
                seen.add(n.id);
            }
            persistSeenFriendIds(seen);
        } catch {
            /* silent — next poll retries */
        }
    }, [user, toast]);

    const refreshUnreadCount = useCallback(async () => {
        if (!user) {
            setUnreadCount(0);
            return;
        }
        try {
            const res = await fetchNotificationsUnreadCount();
            if (!cancelRef.current) {
                setUnreadCount(res.count);
                setLastFetchAt(Date.now());
            }
        } catch {
            /* keep silent — bell is non-critical */
        }
        // Piggy-back on the same 60s interval to surface mutual-friend toasts.
        await checkNewFriendToasts();
    }, [user, checkNewFriendToasts]);

    useEffect(() => {
        cancelRef.current = false;
        if (!user) {
            setUnreadCount(0);
            // Reset the "primed" guard so next sign-in re-establishes a baseline.
            friendPollPrimedRef.current = false;
            return;
        }
        refreshUnreadCount();
        const id = window.setInterval(refreshUnreadCount, 60_000);
        return () => {
            cancelRef.current = true;
            window.clearInterval(id);
        };
    }, [user, refreshUnreadCount]);

    // Re-fetch on route change so mark-read in the panel updates the bell
    // even on browsers that throttle background intervals.
    useEffect(() => {
        if (user) refreshUnreadCount();
    }, [location.pathname, user, refreshUnreadCount]);

    const markRead = useCallback(async (id: number) => {
        // Optimistic — server is authoritative on next refresh.
        setUnreadCount((c) => Math.max(0, c - 1));
        try {
            await markNotificationRead(id);
        } catch {
            // Roll back; refresh will fix any drift on next interval.
            await refreshUnreadCount();
        }
    }, [refreshUnreadCount]);

    const markAllRead = useCallback(async () => {
        setUnreadCount(0);
        try {
            await markAllNotificationsRead();
        } catch {
            await refreshUnreadCount();
        }
    }, [refreshUnreadCount]);

    const markSeen = useCallback(() => {
        setSeenAt(Date.now());
    }, []);

    const seen = seenAt >= lastFetchAt && lastFetchAt > 0;

    const value = useMemo<NotificationsContextType>(
        () => ({
            unreadCount,
            seen,
            refreshUnreadCount,
            markRead,
            markAllRead,
            markSeen,
        }),
        [unreadCount, seen, refreshUnreadCount, markRead, markAllRead, markSeen],
    );

    return (
        <NotificationsContext.Provider value={value}>
            {children}
        </NotificationsContext.Provider>
    );
}

export function useNotifications(): NotificationsContextType {
    const ctx = useContext(NotificationsContext);
    if (!ctx)
        throw new Error('useNotifications must be used within NotificationsProvider');
    return ctx;
}
