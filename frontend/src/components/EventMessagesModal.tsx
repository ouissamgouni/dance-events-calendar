import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import {
    deleteEventMessage,
    fetchEventMessages,
    muteEventMessages,
    postEventMessage,
    reportEventMessage,
    type EventMessage,
    type EventMessageCategory,
} from '../api';
import { useAuth } from '../context/AuthContext';
import { CATEGORY_META, CATEGORY_ORDER, timeAgo } from '../utils/eventMessages';
import { ConfirmDialog } from './AppDialog';
import { useToast } from './Toast';

const PAGE_SIZE = 10;

function Avatar({ url, name }: { url: string | null; name: string }) {
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    if (url) {
        return (
            <img
                src={url}
                alt=""
                // eslint-disable-next-line no-restricted-syntax -- avatar (allowed exception per frontend rules)
                className="h-8 w-8 rounded-full object-cover bg-slate-100 shrink-0"
            />
        );
    }
    return (
        <div
            // eslint-disable-next-line no-restricted-syntax -- avatar placeholder (allowed exception per frontend rules)
            className="h-8 w-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-xs font-semibold shrink-0"
        >
            {initial}
        </div>
    );
}

// Shared props threaded down to the module-level card components. Keeping these
// components at module scope (rather than nested in the modal body) is what
// preserves the reply textarea's focus across keystrokes — nested definitions
// would be new component types on every render and remount their subtree.
interface CardCallbacks {
    signedIn: boolean;
    isPast: boolean;
    isAdmin: boolean;
    posting: boolean;
    replyTo: string | null;
    replyBody: string;
    setReplyTo: (id: string | null) => void;
    setReplyBody: (v: string) => void;
    reportTo: string | null;
    reportReason: string;
    setReportTo: (id: string | null) => void;
    setReportReason: (v: string) => void;
    onReply: (parent: EventMessage) => void;
    onReport: (msg: EventMessage) => void;
    onDelete: (msg: EventMessage) => void;
}

function MessageActions({ msg, cb }: { msg: EventMessage; cb: CardCallbacks }) {
    return (
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
            {cb.signedIn && !cb.isPast ? (
                <button
                    type="button"
                    onClick={() => {
                        cb.setReplyTo(cb.replyTo === msg.id ? null : msg.id);
                        cb.setReplyBody('');
                    }}
                    className="hover:text-slate-700"
                >
                    Reply
                </button>
            ) : null}
            {cb.signedIn && !msg.is_own && (
                <button
                    type="button"
                    onClick={() => {
                        cb.setReportTo(cb.reportTo === msg.id ? null : msg.id);
                        cb.setReportReason('');
                    }}
                    className="hover:text-rose-600"
                >
                    Report
                </button>
            )}
            {(msg.can_delete || cb.isAdmin) && (
                <button type="button" onClick={() => cb.onDelete(msg)} className="hover:text-rose-600">
                    Delete
                </button>
            )}
        </div>
    );
}

function MessageCard({ msg, isReply, cb }: { msg: EventMessage; isReply?: boolean; cb: CardCallbacks }) {
    const meta = CATEGORY_META[msg.category] ?? CATEGORY_META.other;
    const name = msg.author?.display_name || (msg.author ? `@${msg.author.handle}` : 'Someone');
    const mention = msg.reply_to
        ? msg.reply_to.display_name || `@${msg.reply_to.handle}`
        : null;
    return (
        <div className={isReply ? 'flex gap-2' : 'flex gap-3'}>
            <Avatar url={msg.author?.avatar_url ?? null} name={name} />
            <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-slate-900 truncate">{name}</span>
                    {msg.author?.is_verified_organizer && (
                        <img
                            src="/orga.png"
                            alt=""
                            title="Verified organizer"
                            className="inline-block h-3.5 w-3.5 object-contain"
                        />
                    )}
                    {!isReply && (
                        <span className={`px-1.5 py-0.5 text-xs font-medium ${meta.badge}`}>
                            {meta.emoji} {meta.label}
                        </span>
                    )}
                    <span className="text-xs text-slate-400">· {timeAgo(msg.created_at)}</span>
                </div>
                <p className="text-xs text-slate-700 whitespace-pre-wrap break-words">
                    {mention && <span className="font-semibold text-blue-600">@{mention} </span>}
                    {msg.body}
                </p>
                <MessageActions msg={msg} cb={cb} />
                {cb.replyTo === msg.id && (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                        <textarea
                            value={cb.replyBody}
                            onChange={(e) => cb.setReplyBody(e.target.value)}
                            rows={2}
                            maxLength={2000}
                            placeholder="Write a reply…"
                            className="w-full border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                        />
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                disabled={cb.posting || !cb.replyBody.trim()}
                                onClick={() => cb.onReply(msg)}
                                className="bg-blue-500 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                            >
                                {cb.posting ? 'Posting…' : 'Reply'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    cb.setReplyTo(null);
                                    cb.setReplyBody('');
                                }}
                                className="text-xs text-slate-500 hover:text-slate-700"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
                {cb.reportTo === msg.id && (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                        <textarea
                            value={cb.reportReason}
                            onChange={(e) => cb.setReportReason(e.target.value)}
                            rows={2}
                            maxLength={280}
                            placeholder="Report to moderators — add an optional reason"
                            className="w-full border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:border-rose-400"
                        />
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                disabled={cb.posting}
                                onClick={() => cb.onReport(msg)}
                                className="bg-rose-500 px-3 py-1 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-50"
                            >
                                Report
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    cb.setReportTo(null);
                                    cb.setReportReason('');
                                }}
                                className="text-xs text-slate-500 hover:text-slate-700"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
                {!isReply && msg.replies?.length > 0 && (
                    <div className="mt-2 space-y-2 border-l-2 border-slate-100 pl-3">
                        {msg.replies.map((r) => (
                            <MessageCard key={r.id} msg={r} isReply cb={cb} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

interface Props {
    eventId: string;
    onClose: () => void;
    /** Whether the edition has already taken place — closes the board to
     *  new posts and replies (read-only). */
    isPast?: boolean;
    /** Focus the compose box on open (from the "Ask" CTA). */
    initialCompose?: boolean;
    /** Preselect the compose category (from a category filter pill). */
    initialCategory?: EventMessageCategory;
    /** Called after any create/delete so the parent preview can refresh. */
    onChanged?: () => void;
}

export default function EventMessagesModal({ eventId, onClose, isPast = false, initialCompose, initialCategory, onChanged }: Props) {
    const { user } = useAuth();
    const location = useLocation();
    const toast = useToast();
    const isAdmin = !!user?.is_admin;

    const [items, setItems] = useState<EventMessage[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [filter, setFilter] = useState<EventMessageCategory | 'all'>('all');

    const [composeCategory, setComposeCategory] = useState<EventMessageCategory>(initialCategory ?? 'question');
    const [composeBody, setComposeBody] = useState('');
    const [posting, setPosting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [replyTo, setReplyTo] = useState<string | null>(null);
    const [replyBody, setReplyBody] = useState('');

    // Inline report form (mirrors the reply form): the message whose report
    // box is open, plus its optional reason text.
    const [reportTo, setReportTo] = useState<string | null>(null);
    const [reportReason, setReportReason] = useState('');

    const [muted, setMuted] = useState(false);

    // Replaces native window.confirm/prompt/alert (browser dialogs are
    // disallowed): a message pending delete confirmation.
    const [confirmDelete, setConfirmDelete] = useState<EventMessage | null>(null);

    const load = useCallback(
        async (offset: number, replace: boolean) => {
            setLoading(true);
            try {
                const res = await fetchEventMessages(eventId, {
                    category: filter === 'all' ? undefined : filter,
                    limit: PAGE_SIZE,
                    offset,
                });
                setItems((prev) => (replace ? res.items : [...prev, ...res.items]));
                setTotal(res.total);
                if (replace) setMuted(!!res.muted);
                setHasMore(offset + res.items.length < res.total);
            } catch {
                if (replace) setItems([]);
                setHasMore(false);
            } finally {
                setLoading(false);
            }
        },
        [eventId, filter],
    );

    useEffect(() => {
        load(0, true);
    }, [load]);

    // Close on Escape.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const reload = useCallback(() => {
        load(0, true);
        onChanged?.();
    }, [load, onChanged]);

    const handlePost = useCallback(async () => {
        const body = composeBody.trim();
        if (!body) return;
        setPosting(true);
        setError(null);
        try {
            await postEventMessage(eventId, { category: composeCategory, body });
            setComposeBody('');
            reload();
        } catch {
            setError('Could not post your message. Please try again.');
        } finally {
            setPosting(false);
        }
    }, [composeBody, composeCategory, eventId, reload]);

    const handleReply = useCallback(
        async (parent: EventMessage) => {
            const body = replyBody.trim();
            if (!body) return;
            setPosting(true);
            setError(null);
            try {
                await postEventMessage(eventId, { category: parent.category, body, parentId: parent.id });
                setReplyBody('');
                setReplyTo(null);
                reload();
            } catch {
                setError('Could not post your reply. Please try again.');
            } finally {
                setPosting(false);
            }
        },
        [replyBody, eventId, reload],
    );

    const handleDelete = useCallback((msg: EventMessage) => {
        setConfirmDelete(msg);
    }, []);

    const performDelete = useCallback(async () => {
        const msg = confirmDelete;
        setConfirmDelete(null);
        if (!msg) return;
        try {
            await deleteEventMessage(eventId, msg.id);
            reload();
        } catch {
            setError('Could not delete the message.');
        }
    }, [confirmDelete, eventId, reload]);

    const handleReport = useCallback(
        async (msg: EventMessage) => {
            const reason = reportReason.trim();
            setReportTo(null);
            setReportReason('');
            try {
                await reportEventMessage(eventId, msg.id, reason || undefined);
                toast.push({
                    title: 'Thanks — this message has been reported to the moderators.',
                    variant: 'success',
                });
            } catch {
                setError('Could not report the message.');
            }
        },
        [reportReason, eventId, toast],
    );

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
            setError('Could not update your mute setting.');
        }
    }, [muted, eventId, toast]);

    const loginNext = useMemo(
        () => `/login?next=${encodeURIComponent(`${location.pathname}${location.search}#messages`)}`,
        [location.pathname, location.search],
    );

    const cardCallbacks: CardCallbacks = {
        signedIn: !!user,
        isPast,
        isAdmin,
        posting,
        replyTo,
        replyBody,
        setReplyTo,
        setReplyBody,
        reportTo,
        reportReason,
        setReportTo,
        setReportReason,
        onReply: handleReply,
        onReport: handleReport,
        onDelete: handleDelete,
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[12000] bg-slate-900/50 flex items-start justify-center p-4 overflow-y-auto"
            onClick={onClose}
        >
            <div
                className="bg-white shadow-lg w-full max-w-lg my-8 border border-slate-200"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Event messages"
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <h2 className="text-base font-bold text-slate-900">
                        Messages{' '}
                        <span className="font-normal tabular-nums text-slate-400">· {total}</span>
                    </h2>
                    <div className="flex items-center gap-3">
                        {user && (
                            <button
                                type="button"
                                onClick={handleToggleMute}
                                aria-pressed={muted}
                                title={muted ? 'Unmute this event' : 'Mute this event'}
                                className="text-slate-400 hover:text-slate-600 text-lg leading-none"
                            >
                                {muted ? '🔕' : '🔔'}
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="text-slate-400 hover:text-slate-600 text-xl leading-none"
                        >
                            ×
                        </button>
                    </div>
                </div>

                {/* Compose */}
                <div className="border-b border-slate-100 px-4 py-3">
                    {isPast ? (
                        <p className="text-xs text-slate-500">
                            This event has ended — the message board is now read-only.
                        </p>
                    ) : user ? (
                        <div className="space-y-2">
                            <div className="flex flex-wrap gap-1.5">
                                {CATEGORY_ORDER.map((c) => {
                                    const meta = CATEGORY_META[c];
                                    const active = composeCategory === c;
                                    return (
                                        <button
                                            key={c}
                                            type="button"
                                            onClick={() => setComposeCategory(c)}
                                            className={`px-2 py-0.5 text-[11px] font-medium border ${active
                                                ? 'border-blue-400 bg-blue-50 text-blue-700'
                                                : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                                                }`}
                                        >
                                            {meta.emoji} {meta.label}
                                        </button>
                                    );
                                })}
                            </div>
                            <textarea
                                autoFocus={initialCompose}
                                value={composeBody}
                                onChange={(e) => setComposeBody(e.target.value)}
                                rows={2}
                                maxLength={2000}
                                placeholder="Ask a question or share a request (accommodation, ride, tickets…)"
                                className="w-full border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                            />
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] text-slate-400">{composeBody.length}/2000</span>
                                <button
                                    type="button"
                                    disabled={posting || !composeBody.trim()}
                                    onClick={handlePost}
                                    className="bg-blue-500 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                                >
                                    {posting ? 'Posting…' : 'Post'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <p className="text-xs text-slate-500">
                            <Link to={loginNext} className="font-medium text-blue-600 hover:text-blue-700">
                                Sign in
                            </Link>{' '}
                            to post a message or reply.
                        </p>
                    )}
                    {error && <p className="mt-1 text-[11px] text-rose-600">{error}</p>}
                </div>

                {/* Category filter */}
                <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2">
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

                {/* List */}
                <div className="max-h-[50vh] overflow-y-auto px-4 py-3 space-y-4">
                    {items.length === 0 && !loading && (
                        <p className="text-xs text-slate-500 py-6 text-center">
                            {isPast ? 'No messages were posted for this event.' : 'No messages yet. Be the first to ask!'}
                        </p>
                    )}
                    {items.map((m) => (
                        <MessageCard key={m.id} msg={m} cb={cardCallbacks} />
                    ))}
                    {hasMore && (
                        <button
                            type="button"
                            disabled={loading}
                            onClick={() => load(items.length, false)}
                            className="w-full border border-slate-200 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                            {loading ? 'Loading…' : 'Load more'}
                        </button>
                    )}
                </div>
            </div>
            <ConfirmDialog
                open={confirmDelete !== null}
                title="Delete message"
                message="Delete this message? This cannot be undone."
                confirmLabel="Delete"
                destructive
                onConfirm={performDelete}
                onCancel={() => setConfirmDelete(null)}
            />
        </div>,
        document.body,
    );
}
