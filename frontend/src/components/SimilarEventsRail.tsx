import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CalendarEvent, ReviewSentiment, SimilarEvents } from '../types';
import { fetchEventSimilar, fetchEventsByIds } from '../api';
import { similarEventsExplorerUrl } from '../utils/similarEventsLink';
import { trackSimilarEventClicked, trackSimilarEventsSeeMoreClicked } from '../utils/tracking';
import RailEventCard from './RailEventCard';

interface Props {
    eventId: string;
    sentiment: ReviewSentiment | null;
    /** Called before navigating away so the host modal can close. */
    onNavigate: () => void;
}

/** "You might like these next" rail on the review thanks screen. */
export default function SimilarEventsRail({ eventId, sentiment, onNavigate }: Props) {
    const navigate = useNavigate();
    const [similar, setSimilar] = useState<SimilarEvents | null>(null);
    const [events, setEvents] = useState<CalendarEvent[]>([]);

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
                <h3 className="text-sm font-semibold text-ink">You might like these next</h3>
                <Link
                    to={similarEventsExplorerUrl(similar)}
                    onClick={() => {
                        trackSimilarEventsSeeMoreClicked();
                        onNavigate();
                    }}
                    className="shrink-0 text-xs font-semibold text-action hover:underline"
                >
                    See more →
                </Link>
            </div>
            <div className="-mx-1 flex gap-2 overflow-x-auto scrollbar-hide px-1 pb-1" aria-label="You might like these next">
                {events.map((event, index) => (
                    <RailEventCard
                        key={event.event_id}
                        event={event}
                        variant="compact"
                        contextLabel="similar event"
                        onClick={(clicked) => {
                            trackSimilarEventClicked(index);
                            onNavigate();
                            navigate(`/event/${encodeURIComponent(clicked.event_id)}`);
                        }}
                    />
                ))}
            </div>
        </section>
    );
}
