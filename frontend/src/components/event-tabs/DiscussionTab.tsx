import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { fetchEventMessages, type EventMessage, type EventMessageCategory } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { timeAgo } from '../../utils/eventMessages';
import { DISCUSSION_CATEGORY_ORDER, DISCUSSION_LABEL, discussionMeta } from '../discussion/discussionLabels';
import DiscussionThread from '../discussion/DiscussionThread';
import NewDiscussionSheet from '../discussion/NewDiscussionSheet';

interface Props {
    eventId: string;
    isPast: boolean;
    /** Bump to open the "New discussion" composer (from the summary). */
    openComposeToken?: number;
    onCountLoaded?: (count: number) => void;
}

const FEED_LIMIT = 50;

/**
 * Full Discussion tab: renders the complete feed directly (no preview → see
 * all), a category filter bar, and opens either an individual thread or the
 * "Start a discussion" bottom sheet. Replaces the legacy Messages board.
 */
export default function DiscussionTab({ eventId, isPast, openComposeToken, onCountLoaded }: Props) {
    const { user } = useAuth();
    const location = useLocation();
    const [items, setItems] = useState<EventMessage[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<EventMessageCategory | 'all'>('all');
    const [thread, setThread] = useState<EventMessage | null>(null);
    const [compose, setCompose] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        fetchEventMessages(eventId, {
            category: filter === 'all' ? undefined : filter,
            limit: FEED_LIMIT,
            offset: 0,
        })
            .then((res) => {
                setItems(res.items);
                setTotal(res.total);
                onCountLoaded?.(res.total);
            })
            .catch(() => { setItems([]); setTotal(0); })
            .finally(() => setLoading(false));
    }, [eventId, filter, onCountLoaded]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (!openComposeToken) return;
        setCompose(true);
    }, [openComposeToken]);

    const loginNext = `/login?next=${encodeURIComponent(`${location.pathname}${location.search}?tab=discussion`)}`;

    if (thread) {
        return (
            <DiscussionThread
                eventId={eventId}
                post={thread}
                isPast={isPast}
                onBack={() => setThread(null)}
                onChanged={load}
            />
        );
    }

    const filterLabel = filter === 'all' ? '' : DISCUSSION_LABEL[filter];

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="space-y-2">
                <h3 className="text-lg font-bold text-ink">
                    Discussion <span className="font-normal tabular-nums text-muted">· {total}</span>
                </h3>
                <p className="text-xs text-ink-soft">Ask questions, coordinate and connect with other attendees.</p>
                {isPast ? null : user ? (
                    <button
                        type="button"
                        onClick={() => setCompose(true)}
                        className="w-full bg-action px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
                    >
                        + Start a discussion
                    </button>
                ) : (
                    <Link
                        to={loginNext}
                        className="block w-full bg-action px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:opacity-90"
                    >
                        Sign in to start a discussion
                    </Link>
                )}
            </div>

            {/* Category filter chips */}
            <div className="-mx-1 flex flex-nowrap gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <button
                    type="button"
                    onClick={() => setFilter('all')}
                    className={`shrink-0 border px-2.5 py-1 text-xs font-medium transition ${filter === 'all' ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft hover:border-action'}`}
                >
                    All
                </button>
                {DISCUSSION_CATEGORY_ORDER.map((c) => {
                    const meta = discussionMeta(c);
                    const active = filter === c;
                    return (
                        <button
                            key={c}
                            type="button"
                            onClick={() => setFilter(c)}
                            className={`shrink-0 border px-2.5 py-1 text-xs font-medium transition ${active ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft hover:border-action'}`}
                        >
                            {meta.emoji} {meta.label}
                        </button>
                    );
                })}
            </div>

            {/* Feed */}
            {loading ? (
                <p className="text-xs text-muted">Loading…</p>
            ) : items.length === 0 ? (
                <div className="space-y-2 py-6 text-center">
                    <p className="text-sm font-semibold text-ink">
                        {filter === 'all' ? 'No discussions yet' : `No ${filterLabel} discussions yet`}
                    </p>
                    {filter === 'all' && (
                        <p className="mx-auto max-w-xs text-xs text-ink-soft">
                            Ask about the venue, accommodation, rides, tickets or anything else related to the event.
                        </p>
                    )}
                    {!isPast && user && (
                        <button
                            type="button"
                            onClick={() => setCompose(true)}
                            className="text-sm font-medium text-action hover:underline"
                        >
                            {filter === 'all' ? 'Start the first discussion' : `+ Start a ${filterLabel} discussion`}
                        </button>
                    )}
                </div>
            ) : (
                <ul className="space-y-2">
                    {items.map((m) => {
                        const meta = discussionMeta(m.category);
                        const name = m.author?.display_name || (m.author ? `@${m.author.handle}` : 'Someone');
                        const repliers = (m.replies ?? []).slice(0, 3);
                        return (
                            <li key={m.id}>
                                <button
                                    type="button"
                                    onClick={() => setThread(m)}
                                    className="flex w-full items-start gap-2 border border-line bg-surface px-3 py-2.5 text-left transition hover:border-action"
                                >
                                    {m.author?.avatar_url ? (
                                        <img src={m.author.avatar_url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                                    ) : (
                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-ink-soft">
                                            {name.charAt(0).toUpperCase()}
                                        </span>
                                    )}
                                    <div className="min-w-0 flex-1 space-y-1">
                                        <div className="flex items-center gap-1.5">
                                            <span className="truncate text-sm font-semibold text-ink">{name}</span>
                                            <span className={`px-1.5 py-0.5 text-[10px] font-medium ${meta.badge}`}>{meta.emoji} {meta.label}</span>
                                            <span className="ml-auto shrink-0 text-[11px] text-muted">{timeAgo(m.created_at)}</span>
                                        </div>
                                        <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm text-ink">{m.body}</p>
                                        {m.reply_count > 0 && (
                                            <div className="flex items-center gap-1.5 pt-0.5">
                                                <div className="flex -space-x-1.5">
                                                    {repliers.map((r) => (
                                                        r.author?.avatar_url ? (
                                                            <img key={r.id} src={r.author.avatar_url} alt="" className="h-4 w-4 rounded-full object-cover ring-1 ring-surface" />
                                                        ) : (
                                                            <span key={r.id} className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[7px] font-semibold text-ink-soft ring-1 ring-surface">
                                                                {(r.author?.display_name || r.author?.handle || '?').charAt(0).toUpperCase()}
                                                            </span>
                                                        )
                                                    ))}
                                                </div>
                                                <span className="text-[11px] text-muted">
                                                    {m.reply_count} repl{m.reply_count === 1 ? 'y' : 'ies'}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                    <span aria-hidden="true" className="mt-1 shrink-0 text-muted">›</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {compose && (
                <NewDiscussionSheet
                    eventId={eventId}
                    initialCategory={filter === 'all' ? undefined : filter}
                    onPosted={() => load()}
                    onClose={() => setCompose(false)}
                />
            )}
        </div>
    );
}
