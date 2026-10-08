import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchAspectTagGroups, fetchSeriesRollup } from '../api';
import { useAuth } from '../context/AuthContext';
import type { EventRatingAggregate, SeriesRatingRollup, TagGroup } from '../types';
import ExperienceBreakdown, { aspectMood } from '../components/ExperienceBreakdown';
import { EventIdModal } from '../components/EventModal';
import { isPlainClick } from '../utils/plainClick';

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
    const [openEventId, setOpenEventId] = useState<string | null>(null);
    const closeEvent = useCallback(() => setOpenEventId(null), []);

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

    const backButton = (
        <button
            type="button"
            onClick={handleBack}
            aria-label="Back"
            className="-ml-2 flex h-11 w-11 items-center justify-center text-ink-soft transition hover:bg-canvas hover:text-ink"
        >
            <ChevronLeft size={22} aria-hidden="true" />
        </button>
    );

    if (loading) {
        return <div className="max-w-lg mx-auto p-4 text-sm text-ink-soft">Loading series…</div>;
    }

    if (error || !series || !asAggregate) {
        return (
            <div className="max-w-lg mx-auto p-4 space-y-3">
                {backButton}
                <p className="text-sm text-ink-soft">This series could not be found.</p>
            </div>
        );
    }

    return (
        <div className="max-w-lg mx-auto px-4 pt-2 pb-6 space-y-5">
            <Helmet>
                <title>{series.canonical_title} — Series</title>
            </Helmet>

            {backButton}

            <header className="space-y-1">
                <h1 className="text-xl font-semibold leading-tight text-ink">{series.canonical_title}</h1>
                <p className="text-sm text-ink-soft">
                    Recurring series · {series.edition_count} edition{series.edition_count === 1 ? '' : 's'} ·{' '}
                    {series.total_review_count} review{series.total_review_count === 1 ? '' : 's'}
                </p>
            </header>

            <ExperienceBreakdown aggregate={asAggregate} aspectLabels={aspectLabels} editionCount={series.reviewed_edition_count} />

            <section className="space-y-2">
                <h2 className="text-base font-semibold text-ink">Editions</h2>
                <ul className="space-y-2">
                    {series.editions.map((e) => (
                        <li key={e.event_id}>
                            <Link
                                to={`/event/${e.event_id}`}
                                onClick={(click) => {
                                    if (!isPlainClick(click)) return;
                                    click.preventDefault();
                                    setOpenEventId(e.event_id);
                                }}
                                className="flex min-h-14 items-center gap-3 rounded-card border border-card-line bg-surface px-3 py-3 transition hover:bg-canvas active:bg-canvas"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="line-clamp-2 text-sm font-medium leading-snug text-ink">{e.title}</div>
                                    <div className="mt-0.5 text-xs text-ink-soft">
                                        {new Date(e.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                                    </div>
                                </div>
                                <div className="shrink-0 text-right">
                                    {e.review_count === 0 ? (
                                        <span className="text-xs text-ink-soft">No reviews</span>
                                    ) : (
                                        <>
                                            <div className="text-sm font-medium text-ink">
                                                {e.display_state === 'full' && e.mood_label
                                                    ? `${aspectMood(e.average_mood).emoji} ${e.mood_label}`
                                                    : 'Early feedback'}
                                            </div>
                                            <div className="text-xs text-ink-soft tabular-nums">
                                                {e.review_count} review{e.review_count === 1 ? '' : 's'}
                                            </div>
                                        </>
                                    )}
                                </div>
                                <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden="true" />
                            </Link>
                        </li>
                    ))}
                </ul>
            </section>
            {openEventId && <EventIdModal eventId={openEventId} onClose={closeEvent} source="series" />}
        </div>
    );
}
