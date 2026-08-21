import { useState } from 'react';
import type { EventRating, PendingReview } from '../types';
import { useUpsertMyRating } from '../context/MyRatingsContext';
import { useInvalidateRatingAggregate } from '../context/RatingAggregatesContext';
import { trackRatingModalOpened } from '../utils/tracking';
import RateEventModal from './RateEventModal';

interface Props {
    review: PendingReview;
    /** Called after the viewer submits a review so the trail can drop the card. */
    onReviewed: (eventId: string) => void;
}

// "yesterday" / "3 days ago" / "on 5 Aug" — a friendly recency label for the
// event the viewer attended. Anything within the last day reads "yesterday".
function attendedWhen(startIso: string | null): string {
    if (!startIso) return 'recently';
    const start = new Date(startIso);
    const days = Math.floor((Date.now() - start.getTime()) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return `on ${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

export default function ShareExperienceCard({ review, onReviewed }: Props) {
    const [open, setOpen] = useState(false);
    const upsertMyRating = useUpsertMyRating();
    const invalidateAggregate = useInvalidateRatingAggregate();

    const title = review.event_title ?? 'an event';

    const handleReviewClick = () => {
        trackRatingModalOpened('for-you-share-experience', false);
        setOpen(true);
    };

    const handleSubmitted = (rating: EventRating) => {
        upsertMyRating(review.event_id, rating);
        invalidateAggregate(review.event_id);
        setOpen(false);
        onReviewed(review.event_id);
    };

    return (
        <div className="flex w-[212px] shrink-0 flex-col justify-between border border-line bg-surface p-2.5 text-xs">
            <p className="text-ink">
                You attended <span className="font-semibold text-ink">{title}</span> {attendedWhen(review.event_start)}.
            </p>
            <div className="mt-2 flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={handleReviewClick}
                    className="inline-flex shrink-0 items-center justify-center bg-action px-3 py-1.5 text-xs font-semibold text-white hover:bg-action focus:outline-none focus:ring-2 focus:ring-blue-300"
                >
                    Review
                </button>
                {review.friend_proof && (
                    <span className="text-right text-[10px] leading-tight text-ink-soft">
                        Reviewed by {review.friend_proof}
                    </span>
                )}
            </div>
            {open && (
                <RateEventModal
                    eventId={review.event_id}
                    initialRating={null}
                    onClose={() => setOpen(false)}
                    onSubmitted={handleSubmitted}
                />
            )}
        </div>
    );
}
