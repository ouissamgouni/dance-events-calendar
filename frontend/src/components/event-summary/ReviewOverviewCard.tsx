import { aspectMood } from '../ExperienceBreakdown';
import type { EventRatingAggregate } from '../../types';

interface Props {
    aggregate: EventRatingAggregate | null;
    /** True when the mood is pooled from the event's series ("Usually …"). */
    crossEdition: boolean;
    /** Open the Reviews detail tab (full page) or navigate there (modal). */
    onOpen: () => void;
}

/**
 * Compact, fully-clickable review overview shown inside EventSummary. Mirrors
 * the mood + "X% rated it Great or Amazing" headline and up to three positive
 * highlight tags; tapping it opens the Reviews tab. Renders nothing until the
 * event (or its series) has enough feedback.
 */
export default function ReviewOverviewCard({ aggregate, crossEdition, onOpen }: Props) {
    if (!aggregate || aggregate.count === 0 || aggregate.display_state === 'none') return null;

    const positivePct = Math.round(aggregate.positive_percentage ?? 0);
    const emoji = aspectMood(aggregate.average_mood).emoji;
    const highlights = aggregate.top_positive_tags.slice(0, 3);
    const headline = aggregate.display_state === 'full' && aggregate.mood_label
        ? (crossEdition ? `Usually ${aggregate.mood_label.toLowerCase()}` : aggregate.mood_label)
        : 'Early feedback';

    return (
        <button
            type="button"
            onClick={onOpen}
            className="flex w-full items-start gap-3 rounded-md border-l-4 border-l-success bg-green-50/50 px-3 py-2.5 text-left transition hover:bg-green-50"
        >
            <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-1.5">
                    <span className="text-sm font-bold text-ink">
                        {emoji} {headline}
                    </span>
                </div>
                <p className="text-[11px] text-ink-soft">
                    <span className="font-semibold text-ink tabular-nums">{positivePct}%</span> rated it Great or Amazing
                    {' · '}
                    Based on {aggregate.count} review{aggregate.count === 1 ? '' : 's'}
                </p>
                {highlights.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                        {highlights.map((t) => (
                            <span
                                key={t.tag_id}
                                className="inline-flex items-center bg-green-50 px-1.5 py-px text-[10px] font-medium text-success"
                            >
                                {t.label}
                            </span>
                        ))}
                    </div>
                )}
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true">
                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
            </svg>
        </button>
    );
}
