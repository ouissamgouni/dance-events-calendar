import type { CalendarEvent, EventRating } from '../types';
import EventCard from './EventCard';
import RateEventButton from './RateEventButton';

interface Props {
    event: CalendarEvent;
    variant: 'pending' | 'reviewed';
    onOpen: (event: CalendarEvent) => void;
    friendProof?: string | null;
    initialRating?: EventRating | null;
    reviewTagLabels?: Map<number, string>;
    onRatingChanged?: (rating: EventRating | null) => void;
    testId?: string;
}

export default function EventReviewCard({
    event,
    variant,
    onOpen,
    friendProof,
    initialRating,
    reviewTagLabels,
    onRatingChanged,
    testId,
}: Props) {
    const isPending = variant === 'pending';

    return (
        <EventCard
            event={event}
            onOpen={onOpen}
            isPast
            showAvatars={false}
            showTags={false}
            showReviews={false}
            showPrice={false}
            showActions={false}
            bottomSlot={(
                <div className={`border-t border-card-line pt-2 ${isPending ? 'flex min-h-11 items-center justify-between gap-3' : ''}`}>
                    {isPending && (friendProof
                        ? <p className="text-xs text-ink-soft">Reviewed by {friendProof}</p>
                        : <span />)}
                    <RateEventButton
                        eventId={event.event_id}
                        appearance={isPending ? 'write' : 'preview'}
                        initialRating={initialRating}
                        isPast
                        inlineModal
                        entryPoint="list"
                        reviewTagLabels={reviewTagLabels}
                        onRatingChanged={onRatingChanged}
                    />
                </div>
            )}
            testId={testId}
        />
    );
}
