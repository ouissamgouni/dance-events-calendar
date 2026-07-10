import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../types';
import { formatCountdown } from '../utils/relativeDate';
import RailEventCard from './RailEventCard';

interface YourNextEventsRailProps {
    /** Union of the viewer's saved + going events, sorted by start date ascending. */
    events: CalendarEvent[];
    onEventClick: (event: CalendarEvent) => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    /** Unseen tracking — cards for events in this set get the blue-dot
     * "New" indicator, matching EventListPanel. */
    newEventIds?: Set<string>;
    unseenStateEnabled?: boolean;
    className?: string;
    /** Optional content rendered on the right side of the header, e.g. metrics. */
    headerRight?: ReactNode;
}

const DISPLAY_CAP = 5;

export default function YourNextEventsRail({
    events,
    onEventClick,
    hoveredEventId,
    onEventHover,
    newEventIds,
    unseenStateEnabled = false,
    className = '',
    headerRight,
}: YourNextEventsRailProps) {
    // Rails are expanded by default on both mobile and desktop; the
    // header caret still lets the viewer collapse them per session.
    const [collapsed, setCollapsed] = useState(false);
    const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : false));
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia('(max-width: 639px)');
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    if (events.length === 0) return null;

    const visibleEvents = events.slice(0, DISPLAY_CAP);

    return (
        <section className={className} data-testid="your-next-events-rail">
            <div className="flex w-full items-center justify-between border-b border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700">
                <button
                    type="button"
                    className="flex flex-1 items-center justify-between gap-2 text-left hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-300"
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? 'Expand Your next events' : 'Collapse Your next events'}
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <span className="inline-flex items-center gap-1">
                        Your next events
                    </span>
                    <span className="inline-flex items-center gap-2">
                        {headerRight && (
                            <span className="text-[11px] font-medium text-slate-500">{headerRight}</span>
                        )}
                        <span aria-hidden="true" className="text-xs text-slate-400">{collapsed ? '+' : '-'}</span>
                    </span>
                </button>
                <Link
                    to="/my-calendar"
                    className="ml-2 shrink-0 text-[11px] font-semibold text-blue-600 hover:text-blue-700"
                >
                    See in calendar
                </Link>
            </div>
            {!collapsed && (
                <div className="flex gap-2 overflow-x-auto px-2 py-2" aria-label="Your next events">
                    {visibleEvents.map((event) => {
                        const countdown = formatCountdown(event.start, new Date(), isMobile);
                        const isNew = !!unseenStateEnabled && !!newEventIds?.has(event.event_id);
                        return (
                            <RailEventCard
                                key={event.event_id}
                                event={event}
                                onClick={onEventClick}
                                onHover={onEventHover}
                                highlighted={hoveredEventId === event.event_id}
                                isNew={isNew}
                                contextLabel="your event"
                                extraBadge={countdown ? (
                                    <span
                                        className="inline-flex shrink-0 items-center bg-blue-100 px-1.5 py-px text-[10px] font-semibold text-blue-700"
                                        data-testid="your-next-events-countdown"
                                    >
                                        {countdown}
                                    </span>
                                ) : undefined}
                            />
                        );
                    })}
                    <Link
                        to="/my-calendar"
                        className="flex min-h-[72px] w-[110px] shrink-0 items-center justify-center bg-slate-50 text-center text-[11px] font-semibold text-blue-600 transition hover:bg-slate-100 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
                        data-testid="your-next-events-see-more"
                    >
                        See more →
                    </Link>
                </div>
            )}
        </section>
    );
}
