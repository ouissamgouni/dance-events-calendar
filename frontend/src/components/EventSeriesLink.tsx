import { useEffect, useState } from 'react';
import { fetchEventSeriesRollup } from '../api';
import { useAuth } from '../context/AuthContext';
import SeriesRow from './event-summary/SeriesRow';
import type { SeriesRatingRollup } from '../types';

interface Props {
    eventId: string;
}

/**
 * Inline note linking to the recurring series an event belongs to. Renders
 * nothing unless the event is a member of a resolved series (auth-gated —
 * the series page itself requires sign-in).
 */
export default function EventSeriesLink({ eventId }: Props) {
    const { user } = useAuth();
    const [series, setSeries] = useState<SeriesRatingRollup | null>(null);

    useEffect(() => {
        if (!user) { setSeries(null); return; }
        let cancelled = false;
        fetchEventSeriesRollup(eventId)
            .then((s) => { if (!cancelled) setSeries(s); })
            .catch(() => { if (!cancelled) setSeries(null); });
        return () => { cancelled = true; };
    }, [eventId, user]);

    if (!series) return null;

    return <SeriesRow title={series.canonical_title} to={`/series/${series.series_id}`} />;
}
