import { useMemo, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import BottomSheet from './BottomSheet';
import type { CalendarEvent } from '../types';
import { eventsOnDay, formatCardTime } from '../utils/eventDates';
import { getTagColors } from '../utils/eventColor';
import { trackView } from '../utils/tracking';

interface Props {
    day: Date;
    events: CalendarEvent[];
    onDayChange: (day: Date) => void;
    onEventClick: (event: CalendarEvent) => void;
    onClose: () => void;
}

const MAX_DAY_STEPS = 60;

function adjacentDayWithEvents(events: CalendarEvent[], day: Date, step: 1 | -1): Date | null {
    for (let i = 1; i <= MAX_DAY_STEPS; i++) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i * step);
        if (eventsOnDay(events, candidate).length > 0) return candidate;
    }
    return null;
}

export default function CalendarDaySheet({ day, events, onDayChange, onEventClick, onClose }: Props) {
    const entries = useMemo(() => eventsOnDay(events, day), [events, day]);
    const prevDay = useMemo(() => adjacentDayWithEvents(events, day, -1), [events, day]);
    const nextDay = useMemo(() => adjacentDayWithEvents(events, day, 1), [events, day]);
    // eslint-disable-next-line react-hooks/purity -- render-time clock snapshot for past-event dimming
    const now = Date.now();

    const navButton = (target: Date | null, label: string, icon: ReactNode) => (
        <button
            type="button"
            onClick={() => target && onDayChange(target)}
            disabled={!target}
            aria-label={label}
            className="flex h-11 w-11 shrink-0 items-center justify-center text-ink transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-30"
        >
            {icon}
        </button>
    );

    return (
        <BottomSheet
            title={day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
            subtitle={`${entries.length} event${entries.length === 1 ? '' : 's'}`}
            onClose={onClose}
            headerLeading={navButton(prevDay, 'Previous day with events', <ChevronLeft className="h-5 w-5" aria-hidden="true" />)}
            headerAction={navButton(nextDay, 'Next day with events', <ChevronRight className="h-5 w-5" aria-hidden="true" />)}
        >
            {entries.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-soft">No events this day</p>
            ) : (
                <ul className="flex flex-col gap-2" data-testid="calendar-day-sheet-list">
                    {entries.map(({ event, dayNumber, dayCount }) => {
                        const colors = getTagColors(event);
                        const isPast = new Date(event.end || event.start).getTime() < now;
                        const when = dayCount > 1
                            ? `Day ${dayNumber} of ${dayCount}`
                            : event.all_day ? 'All day' : formatCardTime(new Date(event.start), event.timezone);
                        const place = [event.city, event.country].filter(Boolean).join(', ');
                        return (
                            <li key={event.event_id}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        trackView(event.event_id, 'calendar-day-sheet');
                                        onEventClick(event);
                                    }}
                                    className={`flex w-full items-stretch gap-3 rounded-card border border-card-line bg-surface p-3 text-left transition hover:bg-canvas ${isPast ? 'opacity-60' : ''}`}
                                >
                                    {colors.length > 0 && (
                                        <span className="event-tag-stripes" aria-hidden="true">
                                            {colors.map((c, i) => (
                                                <span key={i} className="event-tag-stripe" style={{ backgroundColor: c }} />
                                            ))}
                                        </span>
                                    )}
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="line-clamp-2 text-[15px] font-semibold leading-5 text-ink">{event.title}</span>
                                        <span className="truncate text-[13px] text-ink-soft">
                                            {when}{place ? ` · ${place}` : ''}
                                        </span>
                                    </span>
                                    {event.has_active_promo_codes && (
                                        <img src="/promo-code.png" alt="" aria-hidden="true" className="h-4 w-4 shrink-0 self-center object-contain" />
                                    )}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </BottomSheet>
    );
}
