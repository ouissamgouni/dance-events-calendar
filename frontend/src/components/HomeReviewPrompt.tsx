import { useState } from 'react';
import type { EventRating } from '../types';
import { useUpsertMyRating } from '../context/MyRatingsContext';
import { useInvalidateRatingAggregate } from '../context/RatingAggregatesContext';
import { useHomeReviewPrompt } from '../hooks/useHomeReviewPrompt';
import RateEventModal from './RateEventModal';

interface Props {
    /** Hold the prompt while another overlay (e.g. an event modal) is open. */
    blocked: boolean;
    onReviewed: (eventId: string) => void;
}

/** Uber-style "How was it?" wizard auto-opened on Home; "Rate next" chains inside the modal. */
export default function HomeReviewPrompt({ blocked, onReviewed }: Props) {
    const { prompt, dismiss, clear } = useHomeReviewPrompt(!blocked);
    const [submitted, setSubmitted] = useState(false);
    const upsertMyRating = useUpsertMyRating();
    const invalidateAggregate = useInvalidateRatingAggregate();

    const eventId = prompt?.prompt?.event_id ?? null;
    if (!eventId || blocked) return null;

    const close = () => {
        if (!submitted) dismiss();
        else clear();
        setSubmitted(false);
    };

    const handleSubmitted = (rating: EventRating) => {
        upsertMyRating(eventId, rating);
        invalidateAggregate(eventId);
        setSubmitted(true);
        onReviewed(eventId);
    };

    return (
        <RateEventModal
            key={eventId}
            eventId={eventId}
            initialRating={null}
            onClose={close}
            onSubmitted={handleSubmitted}
            onChainedReviewed={onReviewed}
            entryPoint="home-prompt"
            prompt={
                prompt?.prompt
                    ? {
                        friendProof: prompt.prompt.friend_proof,
                        showIncentive: prompt.similar_count > 0,
                        onNotNow: close,
                    }
                    : undefined
            }
        />
    );
}
