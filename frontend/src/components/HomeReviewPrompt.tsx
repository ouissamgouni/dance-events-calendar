import { useState } from 'react';
import type { EventRating, PendingReview } from '../types';
import { useUpsertMyRating } from '../context/MyRatingsContext';
import { useInvalidateRatingAggregate } from '../context/RatingAggregatesContext';
import { useHomeReviewPrompt } from '../hooks/useHomeReviewPrompt';
import { trackRatingModalOpened, type RatingEntryPoint } from '../utils/tracking';
import RateEventModal from './RateEventModal';

interface Props {
    /** Hold the prompt while another overlay (e.g. an event modal) is open. */
    blocked: boolean;
    pendingReviews: PendingReview[];
    onReviewed: (eventId: string) => void;
}

/** Uber-style "How was it?" wizard auto-opened on Home, chaining to the next pending review. */
export default function HomeReviewPrompt({ blocked, pendingReviews, onReviewed }: Props) {
    const { prompt, dismiss, clear } = useHomeReviewPrompt(!blocked);
    const [chained, setChained] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);
    const upsertMyRating = useUpsertMyRating();
    const invalidateAggregate = useInvalidateRatingAggregate();

    const eventId = chained ?? prompt?.prompt?.event_id ?? null;
    if (!eventId || blocked) return null;
    const isPrompt = chained === null;
    const entryPoint: RatingEntryPoint = isPrompt ? 'home-prompt' : 'rate-next';
    const remaining = pendingReviews.filter((r) => r.event_id !== eventId);

    const close = () => {
        if (isPrompt && !submitted) dismiss();
        else clear();
        setChained(null);
        setSubmitted(false);
    };

    const handleSubmitted = (rating: EventRating) => {
        upsertMyRating(eventId, rating);
        invalidateAggregate(eventId);
        setSubmitted(true);
        onReviewed(eventId);
    };

    const rateNext = () => {
        const next = remaining[0];
        if (!next) return;
        clear();
        trackRatingModalOpened('rate-next', false);
        setSubmitted(false);
        setChained(next.event_id);
    };

    return (
        <RateEventModal
            key={eventId}
            eventId={eventId}
            initialRating={null}
            onClose={close}
            onSubmitted={handleSubmitted}
            entryPoint={entryPoint}
            prompt={
                isPrompt && prompt?.prompt
                    ? {
                        friendProof: prompt.prompt.friend_proof,
                        showIncentive: prompt.similar_count > 0,
                        onNotNow: close,
                    }
                    : undefined
            }
            rateNext={submitted ? { count: remaining.length, onRateNext: rateNext } : undefined}
        />
    );
}
