import type { EventRatingAggregate } from '../../types';
import { useRatingAggregate } from '../../context/RatingAggregatesContext';
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
    const total = useRatingAggregate(eventId)?.count ?? 0;
    return (
        <>
            <div className="mb-3 space-y-2">
                <h3 className="text-lg font-bold text-ink">
                    Reviews <span className="font-normal tabular-nums text-muted">· {total}</span>
                </h3>
            </div>
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
