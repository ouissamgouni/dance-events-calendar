import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { fetchEventMessages, muteEventMessages, type EventMessage, type EventMessageCategory } from '../api';
import { useAuth } from '../context/AuthContext';
import EventMessagesModal from './EventMessagesModal';
import { useToast } from './Toast';
import { CATEGORY_META, CATEGORY_ORDER, timeAgo } from '../utils/eventMessages';

interface Props {
    eventId: string;
    /** Whether the edition has already taken place (tweaks copy). */
    isPast?: boolean;
    /** Reports the total message count to the parent (e.g. for a teaser). */
    onCountLoaded?: (count: number) => void;
    /** Bump to force a reload after the current user posts elsewhere. */
    refreshToken?: number;
    /** Render a chevron toggle in the header so the whole section can be
     * collapsed (used on the event detail page). */
    collapsible?: boolean;
    /** Bump to open the compose form (used by the details "Ask" action). */
    openComposeToken?: number;
}

const PREVIEW_LIMIT = 3;

export default function EventMessagesSection({ eventId, isPast = false, onCountLoaded, refreshToken, collapsible = false, openComposeToken }: Props) {
    const { user } = useAuth();
    const location = useLocation();
    const toast = useToast();

    const [items, setItems] = useState<EventMessage[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<EventMessageCategory | 'all'>('all');
    const [modal, setModal] = useState<null | { compose: boolean; category?: EventMessageCategory }>(null);
    const [collapsed, setCollapsed] = useState(false);
    const [muted, setMuted] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        fetchEventMessages(eventId, {
            category: filter === 'all' ? undefined : filter,
            limit: PREVIEW_LIMIT,
            offset: 0,
        })
            .then((res) => {
                setItems(res.items);
                setTotal(res.total);
                setMuted(!!res.muted);
                onCountLoaded?.(res.total);
            })
            .catch(() => {
                setItems([]);
                setTotal(0);
            })
            .finally(() => setLoading(false));
    }, [eventId, filter, onCountLoaded]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        if (refreshToken === undefined) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshToken]);

    // The details "Ask" action bumps this token to open the compose form
    // (and expands the section if it was collapsed).
    useEffect(() => {
        if (!openComposeToken) return;
        setCollapsed(false);
        setModal({ compose: true });
    }, [openComposeToken]);

    const handleToggleMute = useCallback(async () => {
        const next = !muted;
        setMuted(next);
        try {
            await muteEventMessages(eventId, next);
            toast.push({
                title: next
                    ? 'Muted — you won’t be notified about messages on this event.'
                    : 'Unmuted — you’ll be notified about messages on this event.',
                variant: 'success',
            });
        } catch {
            setMuted(!next);
        }
    }, [muted, eventId, toast]);

    const loginNext = `/login?next=${encodeURIComponent(`${location.pathname}${location.search}#messages`)}`;

    return (
        <section id="messages" className="space-y-3 max-w-full">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
                    {collapsible && (
                        <button
                            type="button"
                            onClick={() => setCollapsed((v) => !v)}
                            aria-expanded={!collapsed}
                            aria-label={collapsed ? 'Expand messages' : 'Collapse messages'}
                            className="text-slate-400 hover:text-slate-600"
                        >
                            <span
                                aria-hidden="true"
                                className={`inline-block transition-transform ${collapsed ? '' : 'rotate-90'}`}
                            >
                                ▸
                            </span>
                        </button>
                    )}
                    💬 Messages{' '}
                    <span className="text-sm font-normal tabular-nums text-slate-400">· {total}</span>
                </h3>
                {user && (
                    <button
                        type="button"
                        onClick={handleToggleMute}
                        aria-pressed={muted}
                        aria-label={muted ? 'Unmute this event' : 'Mute this event'}
                        title={muted ? 'Unmute this event' : 'Mute this event'}
                        className="shrink-0 text-slate-400 hover:text-slate-600 text-lg leading-none"
                    >
                        {muted ? '🔕' : '🔔'}
                    </button>
                )}
            </div>

            {!collapsed && (
                <>
                    <p className="text-[11px] text-slate-500">
                        {isPast
                            ? 'Questions and requests from attendees.'
                            : 'Coordinate with other attendees — accommodation, rides, tickets, meetups, or any question.'}
                    </p>

                    {/* Ask CTA + category filters */}
                    <div className="flex flex-wrap items-center gap-1.5">
                        {isPast ? null : user ? (
                            <button
                                type="button"
                                onClick={() => setModal({ compose: true })}
                                className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 transition shrink-0"
                                aria-label="Ask a question"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                                    <path fillRule="evenodd" d="M10 2c-4.418 0-8 3.134-8 7 0 1.76.743 3.37 1.97 4.6-.097 1.016-.417 2.13-.771 2.966a.75.75 0 0 0 .95.966 8.53 8.53 0 0 0 2.71-1.34A9.77 9.77 0 0 0 10 16c4.418 0 8-3.134 8-7s-3.582-7-8-7Z" clipRule="evenodd" />
                                </svg>
                                Ask
                            </button>
                        ) : (
                            <Link
                                to={loginNext}
                                className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 transition shrink-0"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                                    <path fillRule="evenodd" d="M10 2c-4.418 0-8 3.134-8 7 0 1.76.743 3.37 1.97 4.6-.097 1.016-.417 2.13-.771 2.966a.75.75 0 0 0 .95.966 8.53 8.53 0 0 0 2.71-1.34A9.77 9.77 0 0 0 10 16c4.418 0 8-3.134 8-7s-3.582-7-8-7Z" clipRule="evenodd" />
                                </svg>
                                Sign in to ask
                            </Link>
                        )}
                        <button
                            type="button"
                            onClick={() => setFilter('all')}
                            className={`px-2 py-0.5 text-[11px] font-medium border ${filter === 'all'
                                ? 'border-slate-400 bg-slate-100 text-slate-700'
                                : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                                }`}
                        >
                            All
                        </button>
                        {CATEGORY_ORDER.map((c) => {
                            const meta = CATEGORY_META[c];
                            const active = filter === c;
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    onClick={() => setFilter(c)}
                                    className={`px-2 py-0.5 text-[11px] font-medium border ${active
                                        ? 'border-slate-400 bg-slate-100 text-slate-700'
                                        : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                                        }`}
                                >
                                    {meta.emoji} {meta.label}
                                </button>
                            );
                        })}
                    </div>

                    {/* Preview cards */}
                    {loading ? (
                        <p className="text-[11px] text-slate-400">Loading…</p>
                    ) : items.length === 0 ? (
                        <p className="text-xs text-slate-500">
                            {filter === 'all'
                                ? 'No messages yet. '
                                : 'Nothing in this category yet. '}
                            {isPast ? null : user ? (
                                <button
                                    type="button"
                                    onClick={() => setModal({ compose: true, category: filter === 'all' ? undefined : filter })}
                                    className="font-medium text-blue-600 hover:text-blue-700"
                                >
                                    Be the first to post!
                                </button>
                            ) : (
                                <Link to={loginNext} className="font-medium text-blue-600 hover:text-blue-700">
                                    Sign in to post.
                                </Link>
                            )}
                        </p>
                    ) : (
                        <div className="space-y-2">
                            <ul className="space-y-2">
                                {items.map((m) => {
                                    const meta = CATEGORY_META[m.category] ?? CATEGORY_META.other;
                                    const name = m.author?.display_name || (m.author ? `@${m.author.handle}` : 'Someone');
                                    const avatarUrl = m.author?.avatar_url ?? null;
                                    const initial = name.charAt(0).toUpperCase();
                                    return (
                                        <li key={m.id}>
                                            <button
                                                type="button"
                                                onClick={() => setModal({ compose: false })}
                                                className="w-full text-left border border-slate-200 px-3 py-2 hover:border-slate-300 hover:bg-slate-50"
                                            >
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    <span className={`px-1.5 py-0.5 text-[10px] font-medium ${meta.badge}`}>
                                                        {meta.emoji} {meta.label}
                                                    </span>
                                                    {avatarUrl ? (
                                                        <img
                                                            src={avatarUrl}
                                                            alt=""
                                                            className="h-5 w-5 shrink-0 rounded-full object-cover"
                                                        />
                                                    ) : (
                                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-slate-600">
                                                            {initial}
                                                        </span>
                                                    )}
                                                    <span className="text-xs font-semibold text-slate-800 truncate">{name}</span>
                                                    <span className="text-[11px] text-slate-400">· {timeAgo(m.created_at)}</span>
                                                </div>
                                                <p className="mt-1 text-sm text-slate-700 line-clamp-2 break-words">{m.body}</p>
                                                {m.reply_count > 0 && (
                                                    <span className="mt-1 inline-block text-[11px] text-slate-400">
                                                        {m.reply_count} repl{m.reply_count === 1 ? 'y' : 'ies'}
                                                    </span>
                                                )}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                            <button
                                type="button"
                                onClick={() => setModal({ compose: false })}
                                className="text-xs font-medium text-blue-600 hover:text-blue-700"
                            >
                                See all messages →
                            </button>
                        </div>
                    )}
                </>
            )}

            {modal && (
                <EventMessagesModal
                    eventId={eventId}
                    isPast={isPast}
                    initialCompose={modal.compose}
                    initialCategory={modal.category}
                    onChanged={load}
                    onClose={() => setModal(null)}
                />
            )}
        </section>
    );
}
