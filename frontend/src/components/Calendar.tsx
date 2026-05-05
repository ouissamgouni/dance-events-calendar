import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import type { EventClickArg, EventContentArg, EventInput, EventHoveringArg } from '@fullcalendar/core';
import type { CalendarEvent } from '../types';
import { trackView } from '../utils/tracking';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { getTagColors } from '../utils/eventColor';

export type CalendarViewMode = 'month' | '3week';

interface Props {
    events: CalendarEvent[];
    sinceDate?: string;
    onDatesChange?: (start: Date, end: Date) => void;
    onEventClick?: (event: CalendarEvent, clickRect?: DOMRect) => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    offMapEventIds?: Set<string>;
    viewMode?: CalendarViewMode;
}

const viewToFcView = (v: CalendarViewMode) => (v === '3week' ? 'dayGrid3Week' : 'dayGridMonth');

const Calendar = forwardRef<FullCalendar, Props>(
    ({ events, sinceDate, onDatesChange, onEventClick, hoveredEventId, onEventHover, offMapEventIds, viewMode = 'month' }, ref) => {
        const { eventColorBarColor } = useFeatureFlags();
        const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);
        useEffect(() => {
            const mq = window.matchMedia('(max-width: 639px)');
            const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
            mq.addEventListener('change', handler);
            return () => mq.removeEventListener('change', handler);
        }, []);

        const innerRef = useRef<FullCalendar>(null);
        useImperativeHandle(ref, () => innerRef.current as FullCalendar);

        // Switch view live when viewMode prop changes
        useEffect(() => {
            const api = innerRef.current?.getApi();
            if (!api) return;
            const target = viewToFcView(viewMode);
            if (api.view.type !== target) {
                const currentDate = api.getDate();
                api.changeView(target, currentDate);
            }
        }, [viewMode]);

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
                backgroundColor: eventColorBarColor,
                borderColor: 'transparent',
                textColor: '#ffffff',
                classNames,
                extendedProps: e,
            };
        });

        const renderEventContent = useCallback((arg: EventContentArg) => {
            const ev = arg.event.extendedProps as CalendarEvent;
            const isOffMap = offMapEventIds?.has(ev.event_id);
            const colors = getTagColors(ev);
            return (
                <div className="fc-event-inner">
                    {colors.length > 0 && (
                        <div className="event-tag-stripes" aria-hidden="true">
                            {colors.map((c, i) => (
                                <span
                                    key={i}
                                    className="event-tag-stripe"
                                    style={{ backgroundColor: isOffMap ? '#d1d5db' : c }}
                                />
                            ))}
                        </div>
                    )}
                    <span className="fc-event-title-text">{arg.event.title}</span>
                </div>
            );
        }, [offMapEventIds]);

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
                ref={innerRef}
                plugins={[dayGridPlugin]}
                initialView={viewToFcView(viewMode)}
                views={{
                    dayGrid3Week: {
                        type: 'dayGrid',
                        duration: { weeks: 3 },
                    },
                }}
                headerToolbar={false}
                events={fcEvents}
                eventClick={handleClick}
                eventMouseEnter={handleMouseEnter}
                eventMouseLeave={handleMouseLeave}
                eventContent={renderEventContent}
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
