import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchEventSeriesRollup } from '../api';
import { useAuth } from '../context/AuthContext';
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

    return (
        <p className="text-xs text-ink-soft">
            This event belongs to the{' '}
            <Link
                to={`/series/${series.series_id}`}
                className="font-medium text-action hover:text-action hover:underline"
            >
                {series.canonical_title}
            </Link>{' '}
            series.
        </p>
    );
}
