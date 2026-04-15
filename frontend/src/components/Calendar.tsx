import { useCallback, forwardRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import type { EventClickArg, EventInput } from '@fullcalendar/core';
import type { CalendarEvent } from '../types';
import { trackEventView } from '../api';

interface Props {
    events: CalendarEvent[];
    sinceDate?: string;
    onDatesChange?: (start: Date, end: Date) => void;
    onEventClick?: (event: CalendarEvent) => void;
}

const Calendar = forwardRef<FullCalendar, Props>(
    ({ events, sinceDate, onDatesChange, onEventClick }, ref) => {
        const now = new Date();

        const fcEvents: EventInput[] = events.map((e) => {
            const isPast = new Date(e.end || e.start) < now;
            return {
                id: e.event_id,
                title: e.title,
                start: e.start,
                end: e.end,
                allDay: e.all_day,
                backgroundColor: e.color || '#3b82f6',
                borderColor: 'transparent',
                classNames: isPast ? ['fc-event-past'] : [],
                extendedProps: e,
            };
        });

        const handleClick = useCallback((info: EventClickArg) => {
            info.jsEvent.preventDefault();
            const ev = info.event.extendedProps as CalendarEvent;
            onEventClick?.(ev);
            trackEventView(ev.event_id).catch(() => { });
        }, [onEventClick]);

        return (
            <FullCalendar
                ref={ref}
                plugins={[dayGridPlugin]}
                initialView="dayGridMonth"
                headerToolbar={false}
                events={fcEvents}
                eventClick={handleClick}
                eventDisplay="block"
                displayEventTime={false}
                height="auto"
                dayMaxEvents={3}
                validRange={sinceDate ? { start: sinceDate } : undefined}
                datesSet={(arg) => onDatesChange?.(arg.start, arg.end)}
            />
        );
    });

Calendar.displayName = 'Calendar';
export default Calendar;
