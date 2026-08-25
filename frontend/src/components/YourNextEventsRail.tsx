import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../types';
import NextUpEventCard from './NextUpEventCard';
import SectionHeading from './SectionHeading';

interface YourNextEventsRailProps {
    /** Upcoming events the viewer is attending, sorted by start date ascending. */
    events: CalendarEvent[];
    onEventClick?: (event: CalendarEvent) => void;
    className?: string;
    loading?: boolean;
}

export default function YourNextEventsRail({ events, onEventClick, className = '', loading = false }: YourNextEventsRailProps) {
    if (loading) return null;

    const nextEvent = events[0];

    return (
        <section className={className} data-testid="your-next-events-rail">
            <SectionHeading
                title="Next up"
                action={events.length > 0
                    ? { label: `${events.length} upcoming`, to: '/mine/calendar?filter=going' }
                    : undefined}
            />
            {nextEvent ? (
                <div className="py-2">
                    <NextUpEventCard
                        event={nextEvent}
                        friendsVariant="avatars"
                        onClick={onEventClick}
                        to={onEventClick ? undefined : `/event/${nextEvent.event_id}`}
                        testId="your-next-event-card"
                    />
                </div>
            ) : (
                <div className="flex items-start gap-3 rounded-card border border-card-line bg-canvas p-3.5" data-testid="your-next-events-empty">
                    <img src="/no-calendar.png" alt="" className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-semibold text-ink">No upcoming events</p>
                        <p className="mt-0.5 text-[13px] text-ink-soft">Find your next dance event</p>
                    </div>
                    <Link to="/" className="shrink-0 text-[13px] font-medium text-action hover:text-action-strong focus:outline-none focus:underline">
                        Explore →
                    </Link>
                </div>
            )}
        </section>
    );
}
