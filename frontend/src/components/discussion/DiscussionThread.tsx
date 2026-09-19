import { useState } from 'react';
import {
    postEventMessage,
    deleteEventMessage,
    reportEventMessage,
    type EventMessage,
} from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../Toast';
import { timeAgo } from '../../utils/eventMessages';
import { discussionMeta } from './discussionLabels';

interface Props {
    eventId: string;
    post: EventMessage;
    isPast: boolean;
    onBack: () => void;
    /** Notify the feed that reply counts / deletions changed. */
    onChanged: () => void;
}

function authorName(m: EventMessage): string {
    return m.author?.display_name || (m.author ? `@${m.author.handle}` : 'Someone');
}

function MessageMenu({ message, onDelete, onReport }: { message: EventMessage; onDelete: () => void; onReport: () => void }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-label="More"
                className="px-1 text-muted transition hover:text-ink-soft"
            >
                •••
            </button>
            {open && (
                <div role="menu" className="absolute right-0 z-[12000] mt-1 w-32 border border-line bg-surface py-1 shadow-lg">
                    {!message.is_own && (
                        <button
                            type="button"
                            onClick={() => { setOpen(false); onReport(); }}
                            className="block w-full px-3 py-1.5 text-left text-xs text-ink transition hover:bg-canvas"
                        >
                            Report
                        </button>
                    )}
                    {message.can_delete && (
                        <button
                            type="button"
                            onClick={() => { setOpen(false); onDelete(); }}
                            className="block w-full px-3 py-1.5 text-left text-xs text-danger transition hover:bg-canvas"
                        >
                            Delete
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Full discussion thread: the original post followed by its replies in
 * chronological order, with a persistent reply composer at the bottom. Replies
 * are visually nested only one level deep (an "@name" prefix). Report/delete
 * live in each message's ••• menu.
 */
export default function DiscussionThread({ eventId, post, isPast, onBack, onChanged }: Props) {
    const { user } = useAuth();
    const toast = useToast();
    const [replies, setReplies] = useState<EventMessage[]>(post.replies ?? []);
    const [text, setText] = useState('');
    const [posting, setPosting] = useState(false);
    const meta = discussionMeta(post.category);

    const submitReply = async () => {
        const body = text.trim();
        if (!body || posting) return;
        setPosting(true);
        try {
            const reply = await postEventMessage(eventId, { category: post.category, body, parentId: post.id });
            setReplies((r) => [...r, reply]);
            setText('');
            onChanged();
        } catch {
            toast.push({ title: 'Could not reply', variant: 'error' });
        } finally {
            setPosting(false);
        }
    };

    const removeMessage = async (id: string, isTopLevel: boolean) => {
        try {
            await deleteEventMessage(eventId, id);
            if (isTopLevel) { onChanged(); onBack(); return; }
            setReplies((r) => r.filter((x) => x.id !== id));
            onChanged();
        } catch {
            toast.push({ title: 'Could not delete', variant: 'error' });
        }
    };

    const report = async (id: string) => {
        try {
            await reportEventMessage(eventId, id);
            toast.push({ title: 'Reported. Thanks for flagging.', variant: 'success' });
        } catch {
            toast.push({ title: 'Could not report', variant: 'error' });
        }
    };

    return (
        <div className="space-y-4">
            <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 text-sm text-action hover:underline"
            >
                ← Discussion
            </button>

            {/* Original post */}
            <article className="space-y-2 border border-line bg-surface p-3">
                <div className="flex items-center gap-2">
                    {post.author?.avatar_url ? (
                        <img src={post.author.avatar_url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                    ) : (
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-ink-soft">
                            {authorName(post).charAt(0).toUpperCase()}
                        </span>
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-ink">{authorName(post)}</span>
                            <span className={`px-1.5 py-0.5 text-[10px] font-medium ${meta.badge}`}>{meta.emoji} {meta.label}</span>
                        </div>
                        <span className="text-[11px] text-muted">{timeAgo(post.created_at)}</span>
                    </div>
                    <MessageMenu message={post} onDelete={() => removeMessage(post.id, true)} onReport={() => report(post.id)} />
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-ink">{post.body}</p>
                <p className="text-[11px] text-muted">
                    {replies.length} repl{replies.length === 1 ? 'y' : 'ies'}
                </p>
            </article>

            {/* Replies */}
            <ul className="space-y-3">
                {replies.map((r) => (
                    <li key={r.id} className="space-y-1 border-b border-card-line pb-3 last:border-b-0">
                        <div className="flex items-center gap-2">
                            {r.author?.avatar_url ? (
                                <img src={r.author.avatar_url} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
                            ) : (
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-ink-soft">
                                    {authorName(r).charAt(0).toUpperCase()}
                                </span>
                            )}
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{authorName(r)}</span>
                            <span className="text-[11px] text-muted">{timeAgo(r.created_at)}</span>
                            <MessageMenu message={r} onDelete={() => removeMessage(r.id, false)} onReport={() => report(r.id)} />
                        </div>
                        <p className="whitespace-pre-wrap break-words pl-9 text-sm text-ink">
                            {r.reply_to && <span className="font-medium text-action">@{r.reply_to.display_name || r.reply_to.handle} </span>}
                            {r.body}
                        </p>
                    </li>
                ))}
            </ul>

            {/* Reply composer */}
            {!isPast && user && (
                <div className="sticky bottom-0 flex items-end gap-2 border-t border-line bg-surface pt-2">
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value.slice(0, 2000))}
                        rows={1}
                        placeholder="Write a reply…"
                        className="min-h-[38px] flex-1 resize-none border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none"
                    />
                    <button
                        type="button"
                        onClick={submitReply}
                        disabled={!text.trim() || posting}
                        className="bg-action px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                    >
                        Reply
                    </button>
                </div>
            )}
        </div>
    );
}
