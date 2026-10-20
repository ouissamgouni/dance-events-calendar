import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CalendarEvent, ReviewSentiment, SimilarEvents } from '../types';
import { fetchEventSimilar, fetchEventsByIds } from '../api';
import { useScrollDots } from '../hooks/useScrollDots';
import { similarEventsExplorerUrl } from '../utils/similarEventsLink';
import { trackSimilarEventClicked, trackSimilarEventsSeeMoreClicked } from '../utils/tracking';
import RailEventCard from './RailEventCard';
import ScrollDotsIndicator from './ScrollDots';

interface Props {
    eventId: string;
    sentiment: ReviewSentiment | null;
    /** Called before navigating away so the host modal can close. */
    onNavigate: () => void;
}

/** "Similar events you might like" rail on the review success sheet. */
export default function SimilarEventsRail({ eventId, sentiment, onNavigate }: Props) {
    const navigate = useNavigate();
    const [similar, setSimilar] = useState<SimilarEvents | null>(null);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(scrollerRef, [events.length]);

    useEffect(() => {
        let cancelled = false;
        fetchEventSimilar(eventId, sentiment)
            .then(async (result) => {
                const rows = await fetchEventsByIds(result.event_ids);
                if (cancelled) return;
                const order = new Map(result.event_ids.map((id, i) => [id, i]));
                setSimilar(result);
                setEvents(
                    rows
                        .filter((e) => order.has(e.event_id))
                        .sort((a, b) => (order.get(a.event_id) ?? 0) - (order.get(b.event_id) ?? 0)),
                );
            })
            .catch(() => { /* the rail is a bonus; the thanks screen still works without it */ });
        return () => { cancelled = true; };
    }, [eventId, sentiment]);

    if (!similar || events.length === 0) return null;

    return (
        <section className="space-y-2 text-left" data-testid="similar-events-rail">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">Similar events you might like</h3>
                <Link
                    to={similarEventsExplorerUrl(similar)}
                    onClick={() => {
                        trackSimilarEventsSeeMoreClicked();
                        onNavigate();
                    }}
                    className="shrink-0 text-sm font-semibold text-action hover:underline"
                >
                    See more →
                </Link>
            </div>
            <div
                ref={scrollerRef}
                className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto overscroll-x-contain scrollbar-hide px-4 pb-1"
                aria-label="Similar events you might like"
            >
                {events.map((event, index) => (
                    <div key={event.event_id} className="flex shrink-0 snap-start">
                        <RailEventCard
                            event={event}
                            variant="compact"
                            mediaTop
                            widthClass="w-[40vw] max-w-[176px] min-w-[144px]"
                            contextLabel="similar event"
                            onClick={(clicked) => {
                                trackSimilarEventClicked(index);
                                onNavigate();
                                navigate(`/event/${encodeURIComponent(clicked.event_id)}`);
                            }}
                        />
                    </div>
                ))}
            </div>
            <ScrollDotsIndicator count={dotCount} activeIndex={activeIndex} onSelect={scrollToIndex} label="Similar events position" />
        </section>
    );
}
