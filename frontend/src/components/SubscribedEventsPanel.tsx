import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    fetchMySubscriptions,
    fetchSubscribedEvents,
    type SubscribedEventItem,
    type SubscribedUser,
} from '../api';

/**
 * "From your subscriptions" section for MyCalendar.
 *
 * Reads /api/social/me/subscribed-events — a server-side aggregation that
 * unions the viewer's subscribed users' public Going attendances and
 * approved Suggestions, gated by the same can_view check the calendar
 * applies. Renders a per-subscription chip filter sourced from
 * /api/social/me/subscriptions so the user can scope to one organizer.
 *
 * Entirely additive: hidden when the user has no subscriptions or when
 * the aggregation returns empty. Does not touch the main event list /
 * map state — keeps the surface independent so a future "My Calendar"
 * unification can move it inline without rewriting fetch logic.
 */
export default function SubscribedEventsPanel() {
    const [subs, setSubs] = useState<SubscribedUser[] | null>(null);
    const [items, setItems] = useState<SubscribedEventItem[] | null>(null);
    const [filterHandle, setFilterHandle] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Fetch subscriptions once for the chip row.
    useEffect(() => {
        let cancelled = false;
        fetchMySubscriptions({ limit: 100 })
            .then((res) => {
                if (!cancelled) setSubs(res.items);
            })
            .catch(() => {
                /* silent — chips degrade to "All" only */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const load = useCallback(async () => {
        try {
            const res = await fetchSubscribedEvents({
                fromHandle: filterHandle ?? undefined,
                limit: 50,
            });
            setItems(res.items);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
        }
    }, [filterHandle]);

    useEffect(() => {
        load();
    }, [load]);

    // Hide entire surface when the viewer has no subscriptions AND no
    // backfilled events. Keep visible while still loading subs/items so
    // there is no flash-of-empty.
    if (subs !== null && subs.length === 0) return null;
    if (items === null && error === null) return null;

    return (
        <section className="border border-slate-200 bg-white">
            <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    From your subscriptions
                </span>
                <Link
                    to="/notifications"
                    className="text-[11px] text-slate-500 hover:text-blue-600"
                >
                    See all updates →
                </Link>
            </div>

            {subs && subs.length > 1 && (
                <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-100">
                    <FilterChip
                        label="All"
                        active={filterHandle === null}
                        onClick={() => setFilterHandle(null)}
                    />
                    {subs.map((s) => (
                        <FilterChip
                            key={s.handle}
                            label={s.display_name || `@${s.handle}`}
                            active={filterHandle === s.handle}
                            onClick={() => setFilterHandle(s.handle)}
                        />
                    ))}
                </div>
            )}

            {error ? (
                <div className="px-3 py-2 text-xs text-red-600">{error}</div>
            ) : items && items.length === 0 ? (
                <p className="px-3 py-3 text-xs text-slate-500">
                    Nothing new from your subscriptions yet.
                </p>
            ) : (
                <ul className="divide-y divide-slate-100">
                    {(items || []).map((item) => (
                        <SubscribedEventRow key={item.event_id} item={item} />
                    ))}
                </ul>
            )}
        </section>
    );
}

function FilterChip({
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
                    ? 'px-2 py-0.5 text-[11px] rounded-full bg-slate-900 text-white'
                    : 'px-2 py-0.5 text-[11px] rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200'
            }
        >
            {label}
        </button>
    );
}

function SubscribedEventRow({ item }: { item: SubscribedEventItem }) {
    const start = useMemo(() => new Date(item.start), [item.start]);
    const dateLabel = start.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
    return (
        <li className="px-3 py-2">
            <Link
                to={`/event/${item.event_id}`}
                className="block text-sm font-medium text-slate-900 hover:text-blue-600 truncate"
            >
                {item.title}
            </Link>
            <p className="text-xs text-slate-500">{dateLabel}</p>
            <ViaList via={item.via} />
        </li>
    );
}

function ViaList({ via }: { via: SubscribedEventItem['via'] }) {
    if (!via || via.length === 0) return null;
    return (
        <p className="mt-0.5 text-[11px] text-slate-400 truncate">
            {via.map((v, i) => {
                const verb =
                    v.kind === 'subscription_going' ? 'is going' : 'added';
                const name = v.actor.display_name || `@${v.actor.handle}`;
                return (
                    <span key={`${v.actor.handle}:${v.kind}`}>
                        {i > 0 ? ' · ' : ''}
                        <Link
                            to={`/u/${v.actor.handle}`}
                            className="hover:text-blue-600"
                        >
                            {name}
                        </Link>{' '}
                        {verb}
                    </span>
                );
            })}
        </p>
    );
}
