import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import NotificationsPanel from './NotificationsPanel';

/**
 * Header bell button. Reads unread count from NotificationsContext (shared
 * with the panel + page) so mark-read interactions update the badge live.
 *
 * The badge is hidden once the user has opened the panel (``seen``); opening
 * the panel also marks every loaded row read server-side (Instagram/
 * Facebook-style "viewing is reading"), so the bell and the rows clear
 * together.
 */
export default function NotificationBell({ className }: { className?: string }) {
    const { user } = useAuth();
    const { unreadCount, seen } = useNotifications();
    const [open, setOpen] = useState(false);

    if (!user) return null;

    const showBadge = unreadCount > 0 && !seen;
    const badge = showBadge
        ? unreadCount > 99
            ? '99+'
            : String(unreadCount)
        : null;

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title="Notifications"
                aria-label={
                    badge ? `Notifications (${unreadCount} unread)` : 'Notifications'
                }
                className={
                    className ??
                    'relative inline-flex items-center justify-center w-11 h-11 text-ink-soft hover:text-ink transition'
                }
            >
                <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="w-6 h-6"
                    aria-hidden="true"
                >
                    <path d="M10 2a5 5 0 0 0-5 5v3.586l-1.207 1.207A1 1 0 0 0 4.5 13.5h11a1 1 0 0 0 .707-1.707L15 10.586V7a5 5 0 0 0-5-5Zm-2 13a2 2 0 1 0 4 0H8Z" />
                </svg>
                {badge && (
                    <span
                        className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold flex items-center justify-center leading-none"
                        aria-hidden="true"
                    >
                        {badge}
                    </span>
                )}
            </button>
            <NotificationsPanel open={open} onClose={() => setOpen(false)} />
        </>
    );
}
