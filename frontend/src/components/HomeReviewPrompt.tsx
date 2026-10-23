import { useEffect, useState } from 'react';
import type { EventRating } from '../types';
import { useUpsertMyRating } from '../context/MyRatingsContext';
import { useInvalidateRatingAggregate } from '../context/RatingAggregatesContext';
import { useHomeReviewPrompt } from '../hooks/useHomeReviewPrompt';
import { useRegisterHomeOverlay } from '../hooks/useHomeOverlays';
import RateEventModal from './RateEventModal';

interface Props {
    userId: string;
    /** Gates the server check only; once open the wizard stays until closed. */
    enabled: boolean;
    /** Fires once this visit's review prompt is resolved (none, dismissed or done). */
    onSettled?: () => void;
}

// ForYouPage listens to drop the event from "Share your experience".
const REVIEWS_CHANGED_EVENT = 'reviews:changed';

function announceReviewed(eventId: string) {
    window.dispatchEvent(new CustomEvent(REVIEWS_CHANGED_EVENT, { detail: { eventId } }));
}

/** Uber-style "How was it?" wizard auto-opened app-wide; "Rate next" chains inside the modal. */
export default function HomeReviewPrompt({ userId, enabled, onSettled }: Props) {
    const { prompt, dismiss, clear, settled } = useHomeReviewPrompt(enabled, userId);
    const [submitted, setSubmitted] = useState(false);
    const upsertMyRating = useUpsertMyRating();
    const invalidateAggregate = useInvalidateRatingAggregate();

    const eventId = prompt?.prompt?.event_id ?? null;
    useRegisterHomeOverlay(!!eventId);
    useEffect(() => {
        if (settled) onSettled?.();
    }, [settled, onSettled]);
    if (!eventId) return null;

    const close = () => {
        if (!submitted) dismiss();
        else clear();
        setSubmitted(false);
    };

    const handleSubmitted = (rating: EventRating) => {
        upsertMyRating(eventId, rating);
        invalidateAggregate(eventId);
        setSubmitted(true);
        announceReviewed(eventId);
    };

    return (
        <RateEventModal
            key={eventId}
            eventId={eventId}
            initialRating={null}
            onClose={close}
            onSubmitted={handleSubmitted}
            onChainedReviewed={announceReviewed}
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
