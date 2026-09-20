import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Repeat } from 'lucide-react';
import { fetchEventSeriesRollup } from '../api';
import { useAuth } from '../context/AuthContext';
import SeriesRow from './event-summary/SeriesRow';
import type { SeriesRatingRollup } from '../types';

interface Props {
    eventId: string;
    variant?: 'inline' | 'details';
}

/**
 * Inline note linking to the recurring series an event belongs to. Renders
 * nothing unless the event is a member of a resolved series (auth-gated —
 * the series page itself requires sign-in).
 */
export default function EventSeriesLink({ eventId, variant = 'inline' }: Props) {
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

    if (variant === 'details') {
        return (
            <Link
                to={`/series/${series.series_id}`}
                aria-label={`Open series ${series.canonical_title}`}
                className="block rounded-card border border-card-line bg-surface p-4 hover:border-line"
            >
                <div className="flex items-center gap-2">
                    <Repeat className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />
                    <h2 className="text-sm font-semibold text-ink">Event series</h2>
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                </div>
                <div className="mt-3 pl-6">
                    <p className="text-sm font-semibold text-ink">{series.canonical_title}</p>
                    <p className="mt-1 text-xs text-ink-soft">
                        Part of a {series.edition_count}-event series
                    </p>
                </div>
            </Link>
        );
    }

    return <SeriesRow title={series.canonical_title} to={`/series/${series.series_id}`} />;
}
