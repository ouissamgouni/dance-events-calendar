import { Clock, MapPin } from 'lucide-react';
import type { CalendarEvent } from '../../types';
import DateBlock from './DateBlock';

interface Props {
    event: CalendarEvent;
    /** `modal` shows city/country; `page` shows the full location string. */
    variant: 'page' | 'modal';
}

/**
 * The event identity block shared by the modal (top of EventSummary) and the
 * full page (rendered above the detail tabs): optional image, date block,
 * title, time line, and location.
 */
export default function SummaryHeader({ event, variant }: Props) {
    const start = new Date(event.start);
    const end = new Date(event.end);
    const timeFmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const dayFmt = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const sameDay = start.toDateString() === end.toDateString();
    const timeLine = event.all_day
        ? (sameDay ? 'All day' : `${dayFmt(start)} – ${dayFmt(end)}`)
        : `${timeFmt(start)} → ${sameDay ? '' : `${dayFmt(end)} · `}${timeFmt(end)}`;

    const locationText = variant === 'modal'
        ? [event.city, event.country].filter(Boolean).join(', ') || event.location
        : event.location;

    return (
        <div className="space-y-3">
            {event.image_url && (
                <img
                    src={event.image_url}
                    alt=""
                    className="h-[140px] w-full object-cover"
                />
            )}

            <div className="flex gap-3">
                <DateBlock date={start} />
                <div className="min-w-0 flex-1 space-y-1">
                    <h2 className="text-xl font-bold leading-snug text-ink">{event.title}</h2>
                    <p className="flex items-center gap-1.5 text-xs text-ink-soft">
                        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 truncate">{timeLine}</span>
                    </p>
                    {locationText && (
                        <p className="flex items-center gap-1.5 text-xs text-ink-soft">
                            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 truncate">{locationText}</span>
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
