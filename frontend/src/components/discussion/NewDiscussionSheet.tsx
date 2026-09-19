import { useEffect, useState } from 'react';
import { postEventMessage, type EventMessage, type EventMessageCategory } from '../../api';
import { useToast } from '../Toast';
import { DISCUSSION_CATEGORY_ORDER, discussionMeta } from './discussionLabels';

const MAX = 2000;

interface Props {
    eventId: string;
    initialCategory?: EventMessageCategory;
    onPosted: (message: EventMessage) => void;
    onClose: () => void;
}

/**
 * Bottom-sheet composer for starting a new discussion. Shows a category grid
 * then a text composer with a live counter; Post stays disabled until valid
 * content exists. The category can be changed before posting. On success the
 * caller inserts the new post into the feed — this sheet never navigates.
 */
export default function NewDiscussionSheet({ eventId, initialCategory, onPosted, onClose }: Props) {
    const toast = useToast();
    const [category, setCategory] = useState<EventMessageCategory>(initialCategory ?? 'question');
    const [body, setBody] = useState('');
    const [posting, setPosting] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const trimmed = body.trim();
    const canPost = trimmed.length > 0 && trimmed.length <= MAX && !posting;

    const submit = async () => {
        if (!canPost) return;
        setPosting(true);
        try {
            const msg = await postEventMessage(eventId, { category, body: trimmed });
            onPosted(msg);
            toast.push({ title: 'Posted', variant: 'success' });
            onClose();
        } catch {
            toast.push({ title: 'Could not post', message: 'Please try again.', variant: 'error' });
        } finally {
            setPosting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-lg bg-surface p-4 pb-6 shadow-2xl animate-slide-up"
            >
                <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-ink">New discussion</h3>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="rounded-full p-1 text-muted transition hover:bg-canvas hover:text-ink-soft"
                    >
                        ✕
                    </button>
                </div>

                <p className="mt-2 text-xs text-ink-soft">What do you want to post?</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                    {DISCUSSION_CATEGORY_ORDER.map((c) => {
                        const meta = discussionMeta(c);
                        const active = c === category;
                        return (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setCategory(c)}
                                aria-pressed={active}
                                className={`flex flex-col items-center gap-1 border px-2 py-3 text-center text-xs font-medium transition ${active ? 'border-action bg-canvas text-action' : 'border-line bg-surface text-ink-soft hover:border-action'}`}
                            >
                                <span aria-hidden="true" className="text-lg">{meta.emoji}</span>
                                {meta.label}
                            </button>
                        );
                    })}
                </div>

                <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value.slice(0, MAX))}
                    rows={4}
                    placeholder="Ask a question or share something with other attendees…"
                    className="mt-3 w-full resize-none border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none"
                />

                <div className="mt-2 flex items-center justify-end gap-3">
                    <span className="text-[11px] tabular-nums text-muted">{trimmed.length}/{MAX}</span>
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!canPost}
                        className="bg-action px-4 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                    >
                        {posting ? 'Posting…' : 'Post'}
                    </button>
                </div>
            </div>
        </div>
    );
}
