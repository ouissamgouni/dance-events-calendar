import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchEventMessages, type EventMessage } from '../api';

interface Props {
    eventId: string;
    /** Source appended as ?src= on the "Open board" link, for attribution. */
    detailLinkSource?: string;
}

/**
 * Compact message-board teaser for surfaces that don't render the full board —
 * the calendar event modal and the explorer card popover. Shows the message
 * count + latest one-line preview and deep-links to the event page's
 * ``#messages`` section. Renders nothing until there is at least one message.
 */
export default function EventMessagesTeaser({ eventId, detailLinkSource }: Props) {
    const [total, setTotal] = useState(0);
    const [latest, setLatest] = useState<EventMessage | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchEventMessages(eventId, { limit: 1, offset: 0 })
            .then((res) => {
                if (cancelled) return;
                setTotal(res.total);
                setLatest(res.items[0] ?? null);
            })
            .catch(() => {
                if (cancelled) return;
                setTotal(0);
                setLatest(null);
            });
        return () => {
            cancelled = true;
        };
    }, [eventId]);

    if (total === 0) return null;

    const boardHref = `/event/${eventId}${detailLinkSource ? `?src=${detailLinkSource}` : ''}#messages`;
    const authorName = latest?.author?.display_name ?? 'Someone';
    const avatarUrl = latest?.author?.avatar_url ?? null;
    const initial = authorName.charAt(0).toUpperCase();

    return (
        <div className="space-y-1.5">
            <h3 className="text-sm font-semibold text-ink">
                💬{' '}
                <Link to={boardHref} className="hover:underline">
                    Messages{' '}
                    <span className="font-normal tabular-nums text-ink-soft">· {total}</span>
                </Link>
            </h3>
            {latest && (
                <p className="flex items-center gap-1.5 text-[11px] text-ink-soft min-w-0">
                    {avatarUrl ? (
                        <img
                            src={avatarUrl}
                            alt=""
                            className="h-5 w-5 shrink-0 rounded-full object-cover"
                        />
                    ) : (
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-ink-soft">
                            {initial}
                        </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                        <span className="font-semibold text-ink">{authorName}</span>{' '}
                        <span className="text-ink-soft">{latest.body}</span>
                    </span>
                    {total > 1 && (
                        <Link
                            to={boardHref}
                            className="shrink-0 font-medium text-sky-600 hover:text-sky-700"
                        >
                            +more
                        </Link>
                    )}
                </p>
            )}
        </div>
    );
}
