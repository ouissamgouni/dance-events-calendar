import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import type { CalendarEvent, SeriesRatingRollup } from '../../types';
import { useCommunityExperience } from '../../hooks/useCommunityExperience';
import { eventDisplayZone } from '../../utils/eventDates';
import { findNextEdition } from '../../utils/eventTiming';

interface Props {
    event: CalendarEvent;
    /** Series already loaded by the caller; omit to let the banner fetch it. */
    series?: SeriesRatingRollup | null;
    onNavigate?: () => void;
}

export default function PastEventBanner({ event, series, onNavigate }: Props) {
    const fetched = useCommunityExperience(event.event_id, true, series === undefined);
    const next = findNextEdition((series === undefined ? fetched.series : series)?.editions);
    const fmt = (iso: string, timeZone?: string) =>
        new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone });

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-canvas px-4 py-3 text-sm" data-testid="past-event-banner">
            <span className="flex items-center gap-2 text-ink-soft">
                <History className="h-4 w-4 shrink-0" aria-hidden="true" />
                Took place on {fmt(event.start, eventDisplayZone(event))}
            </span>
            {next && (
                <Link
                    to={`/event/${encodeURIComponent(next.event_id)}`}
                    onClick={onNavigate}
                    className="font-semibold text-action hover:underline"
                >
                    Next edition: {fmt(next.start)} →
                </Link>
            )}
        </div>
    );
}
