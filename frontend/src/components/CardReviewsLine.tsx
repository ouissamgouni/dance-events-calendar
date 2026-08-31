import { Link } from 'react-router-dom';
import { useRatingAggregate } from '../context/RatingAggregatesContext';
import { useEventMessageCount } from '../context/MessageCountsContext';
import { aspectMood } from './ExperienceBreakdown';

interface CardReviewsLineProps {
    eventId: string;
    /** Gate the reviews half of the row behind the ratings feature flag. */
    showRatings: boolean;
    /** Draw a subtle top separator above the row (default). */
    separator?: boolean;
}

/**
 * Bottom-of-card engagement row: overall impression + review count on the
 * left, questions on the right. Renders nothing when there is no
 * engagement to show, so quiet cards stay quiet.
 */
export default function CardReviewsLine({ eventId, showRatings, separator = true }: CardReviewsLineProps) {
    const agg = useRatingAggregate(eventId);
    const messages = useEventMessageCount(eventId) ?? 0;
    const reviews = showRatings ? (agg?.count ?? 0) : 0;
    const hasMood = showRatings && agg?.display_state === 'full' && !!agg?.mood_label;

    if (!hasMood && reviews === 0 && messages === 0) return null;

    return (
        <div className={`mt-1.5 flex items-center gap-2${separator ? ' border-t border-line pt-1.5' : ''}`}>
            {(hasMood || reviews > 0) && (
                <Link
                    to={`/event/${encodeURIComponent(eventId)}#community`}
                    onClick={(e) => e.stopPropagation()}
                    title="See reviews"
                    className="flex min-w-0 items-center gap-1 text-[11px] text-ink-soft hover:text-ink"
                >
                    {hasMood ? (
                        <span className="truncate">
                            {aspectMood(agg!.average_mood).emoji} {agg!.mood_label}
                            {reviews > 0 && ` \u00b7 ${reviews} review${reviews === 1 ? '' : 's'}`}
                        </span>
                    ) : (
                        <span className="flex items-center gap-1">
                            <img src="/star.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain" />
                            <span className="tabular-nums font-medium">{reviews}</span>
                        </span>
                    )}
                </Link>
            )}
            {messages > 0 && (
                <Link
                    to={`/event/${encodeURIComponent(eventId)}#messages`}
                    onClick={(e) => e.stopPropagation()}
                    title="See messages"
                    aria-label={`${messages} message${messages === 1 ? '' : 's'}`}
                    className="ml-auto flex shrink-0 items-center gap-1 text-ink-soft hover:text-ink"
                >
                    <img src="/question.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain" />
                    <span className="tabular-nums text-[10px] font-medium">{messages} posts</span>
                </Link>
            )}
        </div>
    );
}
