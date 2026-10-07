import { useEffect, useState } from 'react';
import { fetchOverlappingEvents, type OverlappingEvent } from '../api';
import VisibilityChip from './VisibilityChip';

const PAGE = 10;
const ALL = 200;

const fmtRange = (start: string, end: string, allDay: boolean) => {
    const opts: Intl.DateTimeFormatOptions = allDay
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    return `${new Date(start).toLocaleString(undefined, opts)} – ${new Date(end).toLocaleString(undefined, opts)}`;
};

interface Props {
    eventId: string;
    onOpenEvent: (eventId: string) => void;
}

export default function OverlappingEventsSection({ eventId, onOpenEvent }: Props) {
    const [items, setItems] = useState<OverlappingEvent[]>([]);
    const [total, setTotal] = useState(0);
    const [limit, setLimit] = useState(PAGE);

    useEffect(() => {
        let cancelled = false;
        fetchOverlappingEvents(eventId, limit)
            .then((res) => {
                if (cancelled) return;
                setItems(res.items);
                setTotal(res.total);
            })
            .catch(() => { if (!cancelled) setItems([]); });
        return () => { cancelled = true; };
    }, [eventId, limit]);

    if (total === 0) return null;

    return (
        <div className="mt-4 overflow-hidden border border-line bg-canvas" data-testid="overlapping-events">
            <p className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                Happening at the same time ({total})
            </p>
            <ul className="divide-y divide-card-line">
                {items.map((item) => (
                    <li key={item.event_id}>
                        <button
                            type="button"
                            onClick={() => onOpenEvent(item.event_id)}
                            className="block w-full px-3 py-2 text-left hover:bg-surface"
                        >
                            <span className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate text-xs font-medium text-ink">{item.title}</span>
                                <VisibilityChip state={item.visibility} />
                            </span>
                            <span className="block text-[11px] text-ink-soft">
                                {fmtRange(item.start, item.end, item.all_day)}
                                {item.location ? ` · ${item.location}` : ''}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            {total > items.length && (
                <button
                    type="button"
                    onClick={() => setLimit(ALL)}
                    className="w-full border-t border-card-line px-3 py-1.5 text-[11px] font-medium text-action hover:bg-surface"
                >
                    Show all
                </button>
            )}
        </div>
    );
}
