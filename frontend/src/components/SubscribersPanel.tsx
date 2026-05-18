import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchMySubscribers, type SubscriberUser } from '../api';

/**
 * Subscribers-to-MY-calendar panel for the MyCalendar page.
 *
 * Mirrors ``SubscriptionsPanel`` (which lists calendars I follow) but in
 * the inverse direction: who is following ME. Owner-only — requires an
 * authenticated session; the underlying GET /api/social/me/subscribers
 * endpoint 401s otherwise. We render nothing on auth failure to keep the
 * MyCalendar page quiet for signed-out viewers (they shouldn't reach this
 * page anyway).
 *
 * No actions are exposed on the rows (the owner cannot force-remove a
 * subscriber today — they'd have to tighten ``visibility_calendar`` to
 * ``private`` to lock everyone out, which is a deliberate choice).
 */
export default function SubscribersPanel() {
    const [items, setItems] = useState<SubscriberUser[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchMySubscribers({ limit: 50 })
            .then((res) => {
                if (!cancelled) setItems(res.items);
            })
            .catch((err) => {
                if (!cancelled)
                    setError(
                        err instanceof Error
                            ? err.message
                            : 'Failed to load subscribers',
                    );
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (items === null && !error) return null;
    if (error) {
        return (
            <div className="border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                {error}
            </div>
        );
    }
    if (!items || items.length === 0) return null;

    return (
        <section className="border border-slate-200 bg-white">
            <div className="px-3 py-2 border-b border-slate-100 text-xs font-medium uppercase tracking-wide text-slate-500">
                Subscribers to your calendar
            </div>
            <ul className="divide-y divide-slate-100">
                {items.map((s) => {
                    const name = s.display_name || `@${s.handle}`;
                    const initial = (name || '?').trim().charAt(0).toUpperCase();
                    return (
                        <li key={s.handle} className="flex items-center gap-3 px-3 py-2">
                            {s.avatar_url ? (
                                <img
                                    src={s.avatar_url}
                                    alt=""
                                    className="w-8 h-8 rounded-full object-cover bg-slate-100"
                                />
                            ) : (
                                <div className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-sm font-semibold">
                                    {initial}
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <Link
                                    to={`/u/${s.handle}`}
                                    className="block truncate text-sm font-medium text-slate-900 hover:text-blue-600"
                                >
                                    {name}
                                    {s.is_verified_organizer && (
                                        <span
                                            className="ml-1 text-blue-600"
                                            title="Verified organizer"
                                            aria-label="Verified organizer"
                                        >
                                            ✓
                                        </span>
                                    )}
                                </Link>
                                <div className="text-xs text-slate-500 truncate">
                                    @{s.handle}
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
