import { useCallback, useEffect, useState, forwardRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import type { EventClickArg, EventInput, EventHoveringArg } from '@fullcalendar/core';
import type { CalendarEvent } from '../types';
import { trackView } from '../utils/tracking';

interface Props {
    events: CalendarEvent[];
    sinceDate?: string;
    onDatesChange?: (start: Date, end: Date) => void;
    onEventClick?: (event: CalendarEvent, clickRect?: DOMRect) => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    offMapEventIds?: Set<string>;
}

const Calendar = forwardRef<FullCalendar, Props>(
    ({ events, sinceDate, onDatesChange, onEventClick, hoveredEventId, onEventHover, offMapEventIds }, ref) => {
        const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);
        useEffect(() => {
            const mq = window.matchMedia('(max-width: 639px)');
            const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
            mq.addEventListener('change', handler);
            return () => mq.removeEventListener('change', handler);
        }, []);

        const now = new Date();

        const fcEvents: EventInput[] = events.map((e) => {
            const isPast = new Date(e.end || e.start) < now;
            const classNames: string[] = [];
            if (isPast) classNames.push('fc-event-past');
            if (offMapEventIds?.has(e.event_id)) classNames.push('fc-event-offmap');
            if (hoveredEventId === e.event_id) classNames.push('fc-event-highlighted');
            return {
                id: e.event_id,
                title: e.title,
                start: e.start,
                end: e.end,
                allDay: e.all_day,
                backgroundColor: e.color || '#3b82f6',
                borderColor: 'transparent',
                classNames,
                extendedProps: e,
            };
        });

        const handleClick = useCallback((info: EventClickArg) => {
            info.jsEvent.preventDefault();
            const ev = info.event.extendedProps as CalendarEvent;
            const rect = (info.el as HTMLElement).getBoundingClientRect();
            onEventClick?.(ev, rect);
            trackView(ev.event_id, 'calendar');
        }, [onEventClick]);

        const handleMouseEnter = useCallback((info: EventHoveringArg) => {
            onEventHover?.(info.event.id);
        }, [onEventHover]);

        const handleMouseLeave = useCallback((_info: EventHoveringArg) => {
            onEventHover?.(null);
        }, [onEventHover]);

        return (
            <FullCalendar
                ref={ref}
                plugins={[dayGridPlugin]}
                initialView="dayGridMonth"
                headerToolbar={false}
                events={fcEvents}
                eventClick={handleClick}
                eventMouseEnter={handleMouseEnter}
                eventMouseLeave={handleMouseLeave}
                eventDisplay="block"
                displayEventTime={false}
                height="auto"
                dayMaxEvents={isMobile ? 2 : 3}
                validRange={sinceDate ? { start: sinceDate } : undefined}
                datesSet={(arg) => onDatesChange?.(arg.start, arg.end)}
            />
        );
    });

Calendar.displayName = 'Calendar';
export default Calendar;
