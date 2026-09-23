import { Search } from 'lucide-react';
import type { EventSearchResult } from '../api';
import type { CalendarEvent } from '../types';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import EventCard from './EventCard';

export type SearchEventCardPurpose = 'browse' | 'select';

interface SearchEventCardProps {
    result: EventSearchResult;
    event?: CalendarEvent;
    onOpen: () => void;
    purpose?: SearchEventCardPurpose;
    highlighted?: boolean;
    testId?: string;
}

export default function SearchEventCard({
    result,
    event,
    onOpen,
    purpose = 'browse',
    highlighted = false,
    testId = 'search-event-card',
}: SearchEventCardProps) {
    const { followingBadgeEnabled, showRatings } = useOptionalFeatureFlags();

    if (event) {
        return (
            <EventCard
                event={event}
                onOpen={onOpen}
                highlighted={highlighted}
                isPast={new Date(event.end).getTime() < Date.now()}
                followingBadgeEnabled={followingBadgeEnabled}
                showRatings={showRatings}
                showActions={purpose === 'browse'}
                tagsFitWidth
                goingIconVariant="hand"
                testId={testId}
            />
        );
    }

    const date = result.start
        ? new Date(result.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : null;
    const place = [result.location, result.city, result.country].filter(Boolean).join(', ');

    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${result.title}`}
            className={`flex min-h-20 w-full gap-3 rounded-card border bg-surface px-3 py-3 text-left hover:bg-canvas ${highlighted ? 'border-action ring-1 ring-action' : 'border-card-line'}`}
            data-testid={testId}
        >
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-field bg-canvas text-action">
                <Search className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink">{result.title}</span>
                {date && <span className="mt-1 block text-xs text-ink-soft">{date}</span>}
                {place && <span className="mt-0.5 block truncate text-xs text-muted">{place}</span>}
            </span>
        </button>
    );
}
