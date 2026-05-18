import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    fetchMySubscriptions,
    type SubscribedUser,
} from '../api';

/**
 * Calendars-I-subscribe-to panel for MyCalendar.
 *
 * Renders the list of organizers/users the current viewer subscribes to.
 * Each row links to the user's public profile (read-only). Subscriptions
 * are removed by unfollowing the user from Account → My network →
 * Following — we deliberately do NOT expose an Unsubscribe button here
 * because subscribe is implicit on follow, so a standalone unsubscribe
 * would leave a stale UserFollow row and an inconsistent UX.
 *
 * Privacy contract: ``can_view_calendar`` is recomputed server-side at read
 * time (the target may have tightened visibility since you subscribed). When
 * it's ``false`` we render the row in muted form with a "No longer
 * available" hint instead of leaking calendar contents.
 *
 * Phase B does NOT yet pull each subscribed user's events into MyCalendar's
 * list — that wiring lands with the notification feed (Phase C) so users get
 * told when a subscribed organizer publishes a new event. Until then this
 * panel is the visible reminder of who you follow for calendar updates.
 */
export default function SubscriptionsPanel({
    showEmpty = false,
    embedded = false,
}: {
    /**
     * When true, render an empty-state hint instead of returning null when
     * the user has no subscriptions. Use on surfaces where the panel must
     * keep its visual footprint (e.g. the half/half row on the Account page).
     */
    showEmpty?: boolean;
    /**
     * When true, drop the outer card chrome (border + heading) so the panel
     * fits inside a parent ``<section>`` that already provides them.
     */
    embedded?: boolean;
} = {}) {
    const [items, setItems] = useState<SubscribedUser[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetchMySubscriptions({ limit: 50 });
            setItems(res.items);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load subscriptions');
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    if (items === null && !error) {
        // First load — keep the surface quiet to avoid layout flicker.
        return null;
    }

    if (error) {
        return (
            <div className="border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                {error}
            </div>
        );
    }

    if (!items || items.length === 0) {
        if (!showEmpty) return null;
        return (
            <p className={embedded ? 'text-xs text-slate-500' : 'text-sm text-slate-500'}>
                You haven't subscribed to any calendars yet. Visit a user's
                profile and click <span className="font-medium">Subscribe</span>{' '}
                to follow their calendar.
            </p>
        );
    }

    const list = (
        <ul className="divide-y divide-slate-100">
            {items.map((sub) => (
                <SubscriptionRow
                    key={sub.handle}
                    sub={sub}
                    compact={embedded}
                />
            ))}
        </ul>
    );

    if (embedded) return list;

    return (
        <section className="border border-slate-200 bg-white">
            <div className="px-3 py-2 border-b border-slate-100 text-xs font-medium uppercase tracking-wide text-slate-500">
                Calendars you subscribe to
            </div>
            {list}
        </section>
    );
}

function SubscriptionRow({
    sub,
    compact = false,
}: {
    sub: SubscribedUser;
    compact?: boolean;
}) {
    const name = sub.display_name || `@${sub.handle}`;
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    // ``compact`` is used by the embedded variant on the Account page where
    // the parent section already provides the heading + outer padding. Drop
    // the row's left padding so the avatar lines up with the section title,
    // and size text down to ``xs`` to match the surrounding "My Events" copy.
    const rowCls = compact
        ? 'flex items-center gap-2 px-0 py-1.5'
        : 'flex items-center gap-3 px-3 py-2';
    const textCls = compact ? 'text-xs' : 'text-sm';
    const avatarSize = compact ? 'w-6 h-6' : 'w-8 h-8';
    const initialCls = compact ? 'text-xs' : 'text-sm';
    return (
        <li className={rowCls}>
            {sub.avatar_url ? (
                <img
                    src={sub.avatar_url}
                    alt=""
                    className={`${avatarSize} rounded-full object-cover bg-slate-100`}
                />
            ) : (
                <div
                    className={`${avatarSize} rounded-full bg-slate-200 text-slate-600 flex items-center justify-center font-semibold ${initialCls}`}
                >
                    {initial}
                </div>
            )}
            <div className="min-w-0 flex-1">
                <Link
                    to={`/u/${sub.handle}`}
                    className={`block truncate font-medium text-slate-900 hover:text-blue-600 ${textCls}`}
                >
                    {name}
                    {sub.is_verified_organizer && (
                        <span
                            className="ml-1 text-blue-600"
                            title="Verified organizer"
                            aria-label="Verified organizer"
                        >
                            ✓
                        </span>
                    )}
                </Link>
                {!sub.can_view_calendar && (
                    <div className="text-xs text-slate-400">
                        No longer available — visibility was tightened.
                    </div>
                )}
            </div>
        </li>
    );
}
