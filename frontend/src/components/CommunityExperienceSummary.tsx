import { Link } from 'react-router-dom';
import { aspectMood } from './ExperienceBreakdown';
import ExperienceMoodBox from './ExperienceMoodBox';
import { useCommunityExperience } from '../hooks/useCommunityExperience';
import { useAuth } from '../context/AuthContext';
import { useRatingAggregate } from '../context/RatingAggregatesContext';

interface Props {
    eventId: string;
    /** Whether the event has already ended. Drives own-reviews vs. pooled
     * "typical experience" for an upcoming edition in a series with history. */
    isPast: boolean;
    /** Source appended as ?src= on the "See full details" link, for attribution. */
    detailLinkSource?: string;
}

/**
 * Compact community-experience summary for surfaces that don't render the full
 * review list — the calendar event modal and the explorer card popover. Shows
 * only the "Overall experience" mood box (or the series' pooled "Typical
 * experience" for an upcoming edition with history) and a "See full details"
 * link to the event page's ``#community`` section. Renders nothing until there
 * are reviews.
 */
export default function CommunityExperienceSummary({ eventId, isPast, detailLinkSource }: Props) {
    const { user } = useAuth();
    const anonAggregate = useRatingAggregate(eventId);
    const { series, crossEdition, aggregate } = useCommunityExperience(eventId, isPast);

    // Signed-out visitors can see the review count (public), but the actual
    // community experience stays gated behind sign-in.
    if (!user) {
        const count = anonAggregate?.count ?? 0;
        if (count === 0) return null;
        return (
            <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-900">
                    Community Experience{' '}
                    <span className="font-normal tabular-nums text-slate-500">
                        · {count} review{count === 1 ? '' : 's'}
                    </span>
                </h3>
                <p className="text-[11px] text-slate-500">
                    <Link
                        to={`/login?next=${encodeURIComponent(`/event/${eventId}#community`)}`}
                        className="font-medium text-sky-600 hover:text-sky-700"
                    >
                        Sign in
                    </Link>{' '}
                    to see and leave reviews for this event.
                </p>
            </div>
        );
    }

    if (!aggregate || aggregate.count === 0 || aggregate.display_state === 'none') return null;

    const editions = series?.reviewed_edition_count ?? 0;

    return (
        <div className="space-y-1.5">
            <ExperienceMoodBox
                label={crossEdition ? 'Typical experience' : 'Overall experience'}
                displayState={aggregate.display_state}
                emoji={aspectMood(aggregate.average_mood).emoji}
                moodLabel={aggregate.mood_label}
                usually={crossEdition}
                positivePercentage={aggregate.positive_percentage ?? 0}
                subline={crossEdition
                    ? `Based on the last ${editions} edition${editions === 1 ? '' : 's'}`
                    : `Based on ${aggregate.count} review${aggregate.count === 1 ? '' : 's'}`}
            />
        </div>
    );
}
