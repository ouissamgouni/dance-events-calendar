import type { SeriesRatingRollup } from '../types';
import { aspectMood } from './ExperienceBreakdown';
import ExperienceMoodBox from './ExperienceMoodBox';

interface Props {
    series: SeriesRatingRollup;
}

/**
 * "Typical experience" card — the recurring series' overall mood, shown on an
 * edition's review section (below its own reviews, or in place of them when the
 * edition has none / is still upcoming). Reuses the pooled series roll-up so an
 * edition never presents an empty review section. Renders nothing unless the
 * series has more than one edition and some feedback to summarise.
 */
export default function TypicalExperienceCard({ series }: Props) {
    if (series.edition_count <= 1 || series.display_state === 'none') return null;

    const editions = series.reviewed_edition_count;

    return (
        <ExperienceMoodBox
            label="Typical experience"
            displayState={series.display_state}
            emoji={aspectMood(series.average_mood).emoji}
            moodLabel={series.mood_label}
            usually
            positivePercentage={series.positive_percentage ?? 0}
            subline={`Based on the last ${editions} edition${editions === 1 ? '' : 's'}`}
            link={{ to: `/series/${series.series_id}`, label: 'See other editions →' }}
        />
    );
}
