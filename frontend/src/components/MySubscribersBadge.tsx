import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchMySubscribers, removeMySubscriber, type SubscriberUser } from '../api';

/**
 * Owner-only "N subscribers" pill that opens a modal listing the users
 * subscribed to the viewer's calendar. Used on the Account page (next to
 * the "My calendar" visibility row) and on the MyCalendar page header.
 *
 * The component fetches lazily on mount so the count is live; the modal
 * fetches a fresh page on open. We intentionally do not coalesce the two
 * fetches — the metric needs only ``total`` and the list page is small
 * enough that re-fetching avoids cache-staleness footguns.
 */
export default function MySubscribersBadge({ className }: { className?: string }) {
    const [count, setCount] = useState<number | null>(null);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchMySubscribers({ limit: 1 })
            .then((res) => {
                if (!cancelled) setCount(res.total);
            })
            .catch((err) => {
                if (!cancelled)
                    setError(err instanceof Error ? err.message : 'Failed to load');
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (error) return null;
    if (count === null) return null;

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={
                    className ??
                    'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 hover:text-blue-700 hover:bg-slate-100 rounded transition'
                }
                title="See who subscribed to your calendar"
            >
                <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-7 8a7 7 0 1 1 14 0H3Z" />
                </svg>
                <span>
                    {count} subscriber{count === 1 ? '' : 's'}
                </span>
            </button>
            {open && (
                <SubscribersModal
                    onClose={() => setOpen(false)}
                    onCountChange={(n) => setCount(n)}
                />
            )}
        </>
    );
}

function SubscribersModal({
    onClose,
    onCountChange,
}: {
    onClose: () => void;
    onCountChange: (n: number) => void;
}) {
    const [items, setItems] = useState<SubscriberUser[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busyHandle, setBusyHandle] = useState<string | null>(null);

    useEffect(() => {
        fetchMySubscribers({ limit: 100 })
            .then((res) => {
                setItems(res.items);
                onCountChange(res.total);
            })
            .catch((err) =>
                setError(err instanceof Error ? err.message : 'Failed to load'),
            );
    }, [onCountChange]);

    const handleRemove = async (handle: string) => {
        if (
            !window.confirm(
                `Remove @${handle} from your subscribers? They'll stop receiving updates from your calendar.`,
            )
        ) {
            return;
        }
        setBusyHandle(handle);
        try {
            await removeMySubscriber(handle);
            setItems((prev) => {
                const next = prev ? prev.filter((s) => s.handle !== handle) : prev;
                if (next) onCountChange(next.length);
                return next;
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to remove');
        } finally {
            setBusyHandle(null);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3"
            onClick={onClose}
        >
            <div
                className="w-full max-w-md bg-white rounded-lg shadow-xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <h3 className="text-sm font-semibold text-slate-900">
                        Subscribers to my calendar
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-700 text-xl leading-none"
                        aria-label="Close"
                    >
                        ×
                    </button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto">
                    {error ? (
                        <p className="p-4 text-sm text-red-700">{error}</p>
                    ) : items === null ? (
                        <p className="p-4 text-sm text-slate-500">Loading…</p>
                    ) : items.length === 0 ? (
                        <p className="p-4 text-sm text-slate-500">
                            No one is subscribed to your calendar yet. Share your
                            profile to grow your audience.
                        </p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {items.map((s) => {
                                const name = s.display_name || `@${s.handle}`;
                                const initial = (name || '?').trim().charAt(0).toUpperCase();
                                return (
                                    <li key={s.handle} className="flex items-center gap-3 px-4 py-2.5">
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
                                                onClick={onClose}
                                                className="block truncate text-sm font-medium text-slate-900 hover:text-blue-600"
                                            >
                                                {name}
                                            </Link>
                                            <div className="text-xs text-slate-500 truncate">
                                                @{s.handle}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => handleRemove(s.handle)}
                                            disabled={busyHandle === s.handle}
                                            className="shrink-0 border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-red-50 hover:border-red-200 hover:text-red-700 transition disabled:opacity-50"
                                            title="Remove this subscriber"
                                        >
                                            {busyHandle === s.handle ? '…' : 'Remove'}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}
