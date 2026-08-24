import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { fetchAspectTagGroups, fetchSeriesRollup } from '../api';
import { useAuth } from '../context/AuthContext';
import type { EventRatingAggregate, SeriesRatingRollup, TagGroup } from '../types';
import ExperienceBreakdown, { aspectMood } from '../components/ExperienceBreakdown';

/**
 * /series/:seriesId — cross-edition rating roll-up for a recurring event.
 *
 * The pooled breakdown (community summary + per-aspect stars + mood headline)
 * reuses ``ExperienceBreakdown`` via a small adapter, then each edition is
 * listed newest-first with its own mini mood summary and a link back to the
 * event page.
 */
export default function SeriesPage() {
    const { seriesId } = useParams<{ seriesId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const { user, loading: authLoading } = useAuth();
    const [series, setSeries] = useState<SeriesRatingRollup | null>(null);
    const [aspectGroups, setAspectGroups] = useState<TagGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    // Reading reviews requires sign-in — bounce to login and back rather than
    // rendering an empty/"not found" page for anonymous visitors.
    useEffect(() => {
        if (authLoading || user) return;
        const returnTo = `${location.pathname}${location.search}${location.hash}`;
        navigate(`/login?next=${encodeURIComponent(returnTo)}`, { replace: true });
    }, [authLoading, user, location, navigate]);

    useEffect(() => {
        if (!seriesId || !user) return;
        let cancelled = false;
        setLoading(true);
        fetchSeriesRollup(Number(seriesId))
            .then((s) => { if (!cancelled) setSeries(s); })
            .catch(() => { if (!cancelled) setError(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [seriesId, user]);


    useEffect(() => {
        fetchAspectTagGroups().then(setAspectGroups).catch(() => setAspectGroups([]));
    }, []);

    const aspectLabels = useMemo(
        () => Object.fromEntries(aspectGroups.map((g) => [g.slug, g.label])),
        [aspectGroups],
    );

    const asAggregate: EventRatingAggregate | null = useMemo(() => {
        if (!series) return null;
        return {
            event_id: '',
            count: series.total_review_count,
            sentiment_distribution: series.sentiment_distribution,
            aspects: series.aspects,
            top_positive_tags: series.top_positive_tags,
            top_neutral_tags: series.top_neutral_tags ?? [],
            top_negative_tags: series.top_negative_tags,
            top_audience_tags: series.top_audience_tags,
            average_mood: series.average_mood,
            positive_percentage: series.positive_percentage,
            neutral_percentage: 0,
            negative_percentage: 0,
            mood_label: series.mood_label,
            display_state: series.display_state,
        };
    }, [series]);

    const handleBack = () => {
        if (window.history.length > 1) navigate(-1);
        else navigate('/');
    };

    if (loading) {
        return <div className="max-w-lg mx-auto p-4 text-sm text-ink-soft">Loading series…</div>;
    }

    if (error || !series || !asAggregate) {
        return (
            <div className="max-w-lg mx-auto p-4 space-y-3">
                <button onClick={handleBack} className="text-xs text-sky-700 hover:text-sky-900">← Back</button>
                <p className="text-sm text-ink-soft">This series could not be found.</p>
            </div>
        );
    }

    return (
        <div className="max-w-lg mx-auto p-4 space-y-4">
            <Helmet>
                <title>{series.canonical_title} — Series</title>
            </Helmet>

            <button onClick={handleBack} className="text-xs text-sky-700 hover:text-sky-900">← Back</button>

            <header>
                <h1 className="text-lg font-semibold text-ink">{series.canonical_title}</h1>
                <p className="text-[11px] text-ink-soft">
                    Recurring series · {series.edition_count} edition{series.edition_count === 1 ? '' : 's'} ·{' '}
                    {series.total_review_count} review{series.total_review_count === 1 ? '' : 's'}
                </p>
            </header>

            <ExperienceBreakdown aggregate={asAggregate} aspectLabels={aspectLabels} editionCount={series.reviewed_edition_count} />

            <section className="space-y-2">
                <h2 className="text-xs font-semibold text-ink uppercase tracking-wide">Editions</h2>
                <ul className="space-y-1.5">
                    {series.editions.map((e) => (
                        <li key={e.event_id}>
                            <Link
                                to={`/event/${e.event_id}`}
                                className="flex items-center justify-between gap-2 border border-line bg-canvas px-2.5 py-1.5 hover:bg-canvas"
                            >
                                <div className="min-w-0">
                                    <div className="text-xs font-medium text-ink truncate">{e.title}</div>
                                    <div className="text-[10px] text-muted">
                                        {new Date(e.start).toLocaleDateString()}
                                    </div>
                                </div>
                                <div className="shrink-0 text-right">
                                    {e.review_count === 0 ? (
                                        <span className="text-[10px] text-muted">No reviews</span>
                                    ) : (
                                        <>
                                            <div className="text-[11px] font-medium text-ink">
                                                {e.display_state === 'full' && e.mood_label
                                                    ? `${aspectMood(e.average_mood).emoji} ${e.mood_label}`
                                                    : 'Early feedback'}
                                            </div>
                                            <div className="text-[10px] text-ink-soft tabular-nums">
                                                {e.review_count} review{e.review_count === 1 ? '' : 's'}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </Link>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}
