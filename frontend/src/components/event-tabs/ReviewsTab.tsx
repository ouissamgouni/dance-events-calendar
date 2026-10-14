import type { EventRatingAggregate } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useSignIn } from '../../context/SignInSheetContext';
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
    const { user } = useAuth();
    const openSignIn = useSignIn();
    const total = useRatingAggregate(eventId)?.count ?? 0;
    return (
        <>
            <div className="mb-3 space-y-2">
                <h3 className="text-lg font-bold text-ink">
                    Reviews <span className="font-normal tabular-nums text-muted">· {total}</span>
                </h3>
                <p className="text-xs text-ink-soft">See how other dancers experienced this event and share your own.</p>
                {!user && (
                    <button
                        type="button"
                        onClick={() => openSignIn('review', { onSignedIn: onOpenReviewForm })}
                        className="block w-full bg-action px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:opacity-90"
                    >
                        Sign in to write a review
                    </button>
                )}
            </div>
            {user && (
                <RateEventButton
                    eventId={eventId}
                    appearance="preview"
                    isEventDetailPage
                    isPast={isPast}
                    hasStarted={hasStarted}
                    entryPoint="detail"
                    onRatingChanged={onRatingChanged}
                />
            )}
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
