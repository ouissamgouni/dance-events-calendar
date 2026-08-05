import { useEffect, useMemo, useState } from 'react';
import { fetchEventSeriesRollup, fetchRatingAggregate } from '../api';
import { useAuth } from '../context/AuthContext';
import type { EventRatingAggregate, SeriesRatingRollup } from '../types';

/** Present a series roll-up as an ``EventRatingAggregate`` so the pooled mood
 * can flow through the same UI as an event's own aggregate. */
export function seriesToAggregate(series: SeriesRatingRollup): EventRatingAggregate {
    return {
        event_id: '',
        count: series.total_review_count,
        sentiment_distribution: series.sentiment_distribution,
        aspects: series.aspects,
        top_positive_tags: series.top_positive_tags,
        top_negative_tags: series.top_negative_tags,
        top_audience_tags: series.top_audience_tags,
        average_mood: series.average_mood,
        positive_percentage: series.positive_percentage,
        neutral_percentage: 0,
        negative_percentage: 0,
        mood_label: series.mood_label,
        display_state: series.display_state,
    };
}

export interface CommunityExperience {
    /** The resolved series this event belongs to (or null). */
    series: SeriesRatingRollup | null;
    /** True when an upcoming edition pools its series' cross-edition feedback. */
    crossEdition: boolean;
    /** The aggregate to display — pooled series roll-up when cross-edition,
     * otherwise the event's own aggregate. Null until loaded. */
    aggregate: EventRatingAggregate | null;
}

/**
 * Shared loader for a surface's "community experience" summary: fetches the
 * event's own aggregate plus the series roll-up (both auth-gated) and derives
 * whether to show the event's own reviews or the series' pooled "typical"
 * experience. Pass ``enabled = false`` to skip fetching entirely (e.g. a map
 * popup that hasn't been opened yet) — every popup mounts eagerly, so gating
 * avoids one request per marker.
 */
export function useCommunityExperience(
    eventId: string,
    isPast: boolean,
    enabled = true,
): CommunityExperience {
    const { user } = useAuth();
    const active = enabled && !!user;
    const [aggregate, setAggregate] = useState<EventRatingAggregate | null>(null);
    const [series, setSeries] = useState<SeriesRatingRollup | null>(null);

    useEffect(() => {
        if (!active) { setAggregate(null); return; }
        let cancelled = false;
        fetchRatingAggregate(eventId)
            .then((a) => { if (!cancelled) setAggregate(a); })
            .catch(() => { if (!cancelled) setAggregate(null); });
        return () => { cancelled = true; };
    }, [eventId, active]);

    useEffect(() => {
        if (!active) { setSeries(null); return; }
        let cancelled = false;
        fetchEventSeriesRollup(eventId)
            .then((s) => { if (!cancelled) setSeries(s); })
            .catch(() => { if (!cancelled) setSeries(null); });
        return () => { cancelled = true; };
    }, [eventId, active]);

    const crossEdition = !isPast && series != null && series.total_review_count > 0;

    const aggregate_ = useMemo(
        () => (crossEdition && series ? seriesToAggregate(series) : aggregate),
        [crossEdition, series, aggregate],
    );

    return { series, crossEdition, aggregate: aggregate_ };
}
