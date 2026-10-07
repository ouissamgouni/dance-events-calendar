import type { EventRatingAggregate } from '../../types';
import EventReviewsSection from '../EventReviewsSection';
import RateEventButton from '../RateEventButton';

interface Props {
    eventId: string;
    isPast: boolean;
    hasStarted?: boolean;
    onAggregateLoaded?: (aggregate: EventRatingAggregate | null) => void;
    onOpenReviewForm?: () => void;
    onRatingChanged?: () => void;
    refreshToken?: number;
}

/** Reviews detail tab — a review CTA on top of the community-experience section. */
export default function ReviewsTab({ eventId, isPast, hasStarted, onAggregateLoaded, onOpenReviewForm, onRatingChanged, refreshToken }: Props) {
    return (
        <>
            <RateEventButton
                eventId={eventId}
                appearance="preview"
                isEventDetailPage
                isPast={isPast}
                hasStarted={hasStarted}
                entryPoint="detail"
                onRatingChanged={onRatingChanged}
            />
            <EventReviewsSection
                eventId={eventId}
                isPast={isPast}
                hasStarted={hasStarted}
                onAggregateLoaded={onAggregateLoaded}
                onOpenReviewForm={onOpenReviewForm}
                refreshToken={refreshToken}
            />
        </>
    );
}
