import type { EventRatingAggregate } from '../../types';
import EventReviewsSection from '../EventReviewsSection';

interface Props {
    eventId: string;
    isPast: boolean;
    onAggregateLoaded?: (aggregate: EventRatingAggregate | null) => void;
    onOpenReviewForm?: () => void;
    refreshToken?: number;
}

/** Reviews detail tab — reuses the existing community-experience section. */
export default function ReviewsTab({ eventId, isPast, onAggregateLoaded, onOpenReviewForm, refreshToken }: Props) {
    return (
        <EventReviewsSection
            eventId={eventId}
            isPast={isPast}
            onAggregateLoaded={onAggregateLoaded}
            onOpenReviewForm={onOpenReviewForm}
            refreshToken={refreshToken}
        />
    );
}
