import { Link, useNavigate } from 'react-router-dom';
import type { ReviewSentiment } from '../types';
import { trackRateNextClicked, trackReviewExploreMoreClicked } from '../utils/tracking';
import SimilarEventsRail from './SimilarEventsRail';

interface Props {
    eventId: string;
    sentiment: ReviewSentiment | null;
    /** A written comment is waiting for moderation, so it isn't public yet. */
    commentPending: boolean;
    /** Offer "Add memories" (memories feature on and the viewer may add some). */
    memoriesLink: boolean;
    /** Unrated attended events left; "Rate next" only shows when > 0. */
    remaining: number;
    onRateNext: () => void;
    onClose: () => void;
}

/** Bottom-sheet content shown right after a review is submitted. */
export default function ReviewSuccessSheet({ eventId, sentiment, commentPending, memoriesLink, remaining, onRateNext, onClose }: Props) {
    const navigate = useNavigate();

    return (
        <div className="relative space-y-5 px-4 pt-2 pb-6" data-testid="review-success-sheet">
            <div className="flex justify-center" aria-hidden>
                {/* eslint-disable-next-line no-restricted-syntax -- drag handle is a pill by design */}
                <span className="h-1 w-10 rounded-full bg-line" />
            </div>
            <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center text-xl text-muted transition hover:text-ink-soft"
            >
                ✕
            </button>
            <div className="space-y-2 text-center">
                <img src="/party-popper.png" alt="" className="mx-auto h-[72px] w-[72px]" />
                <h2 className="text-2xl font-bold text-ink">Thanks for your review!</h2>
                <p className="mx-auto max-w-xs text-sm text-ink-soft">
                    You&rsquo;re helping people find great events and keep the community alive.
                </p>
                {commentPending && (
                    <p className="text-xs text-muted">Your comment will appear once our team has checked it.</p>
                )}
                {memoriesLink && (
                    <Link
                        to={`/event/${encodeURIComponent(eventId)}#memories`}
                        onClick={onClose}
                        className="inline-block text-sm font-semibold text-action hover:underline"
                    >
                        📸 Add memories from the event
                    </Link>
                )}
            </div>
            <SimilarEventsRail eventId={eventId} sentiment={sentiment} onNavigate={onClose} />
            <div className="space-y-2">
                {remaining > 0 && (
                    <button
                        type="button"
                        onClick={() => {
                            trackRateNextClicked();
                            onRateNext();
                        }}
                        className="w-full rounded-field bg-action py-3 text-sm font-semibold text-white hover:opacity-90"
                    >
                        Rate next
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => {
                        trackReviewExploreMoreClicked();
                        onClose();
                        navigate('/browse');
                    }}
                    className="w-full rounded-field bg-blue-50 py-3 text-sm font-semibold text-action hover:bg-blue-100"
                >
                    Explore more events
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    className="w-full py-2 text-sm font-semibold text-action hover:underline"
                >
                    Not now
                </button>
            </div>
        </div>
    );
}
