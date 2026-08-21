import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { fetchAspectTagGroups, fetchEventReviews, fetchEventSeriesRollup, fetchRatingAggregate, fetchSeriesReviews } from '../api';
import { useAuth } from '../context/AuthContext';
import { useRatingAggregate } from '../context/RatingAggregatesContext';
import type { EventRatingAggregate, EventReviewPublic, SeriesRatingRollup, TagGroup } from '../types';
import ExperienceBreakdown from './ExperienceBreakdown';
import TypicalExperienceCard from './TypicalExperienceCard';
import { seriesToAggregate } from '../hooks/useCommunityExperience';
import { SENTIMENT_META } from '../utils/reviewSentiment';

/** Max tags shown on a compact review card before the rest collapse into "+N more". */
const CARD_TAGS_SHOWN = 5;

type CardTag = { key: string; label: string; cls: string };

/** Flatten a review's aspect + audience tags into renderable pills (aspect tags
 * colored by polarity, audience tags neutral). */
function cardTags(r: EventReviewPublic): CardTag[] {
    const aspect = r.aspect_tags.map((t) => ({
        key: `a-${t.id}`,
        label: t.label,
        cls: t.polarity === 'negative' ? 'bg-orange-50 text-orange-800' : 'bg-green-50 text-success',
    }));
    const audience = r.audience_tags.map((t) => ({
        key: `u-${t.id}`,
        label: t.label,
        cls: 'bg-slate-100 text-ink-soft',
    }));
    return [...aspect, ...audience];
}

/** Full review popover — shows the complete feedback (all tags + comment). */
function ReviewDetailModal({ review, onClose }: { review: EventReviewPublic; onClose: () => void }) {
    const meta = review.overall_sentiment ? SENTIMENT_META[review.overall_sentiment] : null;
    const initials =
        review.reviewer_label.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
    const tags = cardTags(review);
    return createPortal(
        <div
            className="fixed inset-0 z-[1100] bg-slate-900/50 flex items-center justify-center p-4"
            onClick={onClose}
        >
            <div
                className="bg-surface shadow-lg w-full max-w-sm max-h-[85vh] overflow-y-auto border border-line p-4 space-y-3"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Review details"
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-ink-soft">
                            {initials}
                        </span>
                        <div className="min-w-0">
                            <div className="text-sm font-semibold text-ink truncate">{review.reviewer_label}</div>
                            <div className="flex items-center gap-1.5 text-xs text-ink-soft">
                                {meta && <span>{meta.emoji} {meta.label}</span>}
                                {meta && <span className="text-slate-300">·</span>}
                                <span>{new Date(review.created_at).toLocaleDateString()}</span>
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Close"
                        className="shrink-0 text-muted hover:text-ink-soft text-xl leading-none"
                    >
                        ×
                    </button>
                </div>
                {review.comment && (
                    <p className="text-sm text-ink whitespace-pre-wrap break-words">{review.comment}</p>
                )}
                {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {tags.map((t) => (
                            <span key={t.key} className={`rounded-full px-2 py-0.5 text-[11px] ${t.cls}`}>
                                {t.label}
                            </span>
                        ))}
                    </div>
                )}
                <Link
                    to={`/event/${review.event_id}`}
                    className="inline-block text-[9px] font-medium text-sky-600 hover:text-sky-700"
                >
                    From {review.event_title} →
                </Link>
            </div>
        </div>,
        document.body,
    );
}

interface Props {
    eventId: string;
    /** Whether the edition has already taken place. Upcoming editions can't be
     * reviewed, so their section shows the series' typical experience instead of
     * a review list. Defaults to true (treat as reviewable) when unknown. */
    isPast?: boolean;
    /** Notifies parent when aggregate count is known (so the rate button can highlight). */
    onAggregateLoaded?: (agg: EventRatingAggregate | null) => void;
    /** Called when user clicks "Be the first to review" in the empty state. Allows parent to open the review form. */
    onOpenReviewForm?: () => void;
    /** Bump this to a new value (e.g. a counter) whenever the current user's rating changed
     * elsewhere on the page, so the aggregate + review list reload without a full remount. */
    refreshToken?: number;
    /** Render a chevron toggle in the header so the whole section can be
     * collapsed (used on the event detail page). */
    collapsible?: boolean;
}

const PAGE_SIZE = 5;

export default function EventReviewsSection({ eventId, isPast = true, onAggregateLoaded, onOpenReviewForm, refreshToken, collapsible = false }: Props) {
    const { user } = useAuth();
    const location = useLocation();
    const [collapsed, setCollapsed] = useState(false);
    // Review count is public — surface it to signed-out visitors from the shared
    // (count-only) aggregate cache so the gated section can still show "N reviews".
    const anonAggregate = useRatingAggregate(eventId);
    const [aggregate, setAggregate] = useState<EventRatingAggregate | null>(null);
    const [reviews, setReviews] = useState<EventReviewPublic[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [sort, setSort] = useState<'recent' | 'positive' | 'critical'>('recent');
    const [aspectGroups, setAspectGroups] = useState<TagGroup[]>([]);
    const [series, setSeries] = useState<SeriesRatingRollup | null>(null);
    const [expandedReview, setExpandedReview] = useState<EventReviewPublic | null>(null);

    const loadAggregate = useCallback(() => {
        if (!user) return;
        fetchRatingAggregate(eventId)
            .then((a) => {
                setAggregate(a);
                onAggregateLoaded?.(a);
            })
            .catch(() => {
                setAggregate(null);
                onAggregateLoaded?.(null);
            });
    }, [eventId, onAggregateLoaded, user]);

    useEffect(() => {
        loadAggregate();
    }, [loadAggregate]);

    useEffect(() => {
        if (!user) { setSeries(null); return; }
        let cancelled = false;
        fetchEventSeriesRollup(eventId)
            .then((s) => { if (!cancelled) setSeries(s); })
            .catch(() => { if (!cancelled) setSeries(null); });
        return () => { cancelled = true; };
    }, [eventId, user]);

    useEffect(() => {
        fetchAspectTagGroups()
            .then(setAspectGroups)
            .catch(() => setAspectGroups([]));
    }, []);

    const aspectLabels = useMemo(
        () => Object.fromEntries(aspectGroups.map((g) => [g.slug, g.label])),
        [aspectGroups],
    );

    const typicalCard = series ? <TypicalExperienceCard series={series} /> : null;

    // An upcoming edition that belongs to a series with past feedback shows the
    // full cross-edition experience (pooled breakdown + reviews from every
    // edition) instead of its own empty review list.
    const crossEdition = !isPast && series != null && series.total_review_count > 0;

    const seriesAggregate: EventRatingAggregate | null = useMemo(
        () => (series ? seriesToAggregate(series) : null),
        [series],
    );

    const effectiveAggregate = crossEdition ? seriesAggregate : aggregate;

    const loadPage = useCallback(
        async (offset: number, replace: boolean) => {
            if (!user) { setReviews([]); setHasMore(false); return; }
            setLoading(true);
            try {
                const res = crossEdition && series
                    ? await fetchSeriesReviews(series.series_id, { sort, limit: PAGE_SIZE, offset })
                    : await fetchEventReviews(eventId, { sort, limit: PAGE_SIZE, offset });
                setReviews((prev) => (replace ? res.items : [...prev, ...res.items]));
                setHasMore(offset + res.items.length < res.total);
            } catch {
                if (replace) setReviews([]);
                setHasMore(false);
            } finally {
                setLoading(false);
            }
        },
        [eventId, sort, user, crossEdition, series],
    );

    useEffect(() => {
        loadPage(0, true);
    }, [loadPage]);

    // Reload the aggregate + first page whenever the parent bumps refreshToken
    // (e.g. right after the current user submits/edits/deletes their review).
    const lastRefreshToken = useRef(refreshToken);
    useEffect(() => {
        if (refreshToken === undefined) return;
        if (lastRefreshToken.current === refreshToken) return;
        lastRefreshToken.current = refreshToken;
        loadAggregate();
        loadPage(0, true);
    }, [refreshToken, loadAggregate, loadPage]);

    // Signed-out visitors: report the public review count so the parent (rate
    // button highlight / anchor) stays in sync even though content is gated.
    useEffect(() => {
        if (user) return;
        onAggregateLoaded?.(anonAggregate);
    }, [user, anonAggregate, onAggregateLoaded]);

    // Chevron toggle injected into each branch's "Community Experience"
    // header when the section is rendered as a collapsible card.
    const collapseChevron = collapsible ? (
        <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand community experience' : 'Collapse community experience'}
            className="mr-1 align-middle text-muted hover:text-ink-soft"
        >
            <span
                aria-hidden="true"
                className={`inline-block transition-transform ${collapsed ? '' : 'rotate-90'}`}
            >
                ▸
            </span>
        </button>
    ) : null;

    if (!user) {
        const count = anonAggregate?.count ?? 0;
        // Nothing to gate behind sign-in when the event has no reviews yet.
        if (count === 0) return null;
        return (
            <section className="mt-4 border-t border-line pt-3 space-y-2">
                <h3 className="text-base font-bold text-ink">
                    {collapseChevron}
                    Community Experience{' '}
                    <span className="text-sm font-normal tabular-nums text-ink-soft">
                        · {count} review{count === 1 ? '' : 's'}
                    </span>
                </h3>
                {!collapsed && (
                    <p className="text-[11px] text-ink-soft">
                        <Link
                            to={`/login?next=${encodeURIComponent(`${location.pathname}${location.search}#community`)}`}
                            className="text-sky-600 hover:text-sky-700 font-medium"
                        >
                            Sign in
                        </Link>{' '}
                        to see and leave reviews for this event.
                    </p>
                )}
            </section>
        );
    }

    if (!effectiveAggregate || effectiveAggregate.count === 0) {
        return (
            <section className="mt-4 border-t border-line pt-3 space-y-2">
                <h3 className="text-base font-bold text-ink">{collapseChevron}Community Experience</h3>
                {!collapsed && (
                    <>
                        {typicalCard}
                        {isPast ? (
                            <p className="text-[11px] text-ink-soft">
                                No reviews for this edition yet.{' '}
                                {onOpenReviewForm ? (
                                    <button
                                        onClick={onOpenReviewForm}
                                        className="text-sky-600 hover:text-sky-700 font-medium"
                                    >
                                        Be the first to leave one!
                                    </button>
                                ) : (
                                    <span>Be the first to leave one!</span>
                                )}
                            </p>
                        ) : (
                            <p className="text-[11px] text-ink-soft">
                                Reviews open after the event takes place.
                            </p>
                        )}
                    </>
                )}
            </section>
        );
    }

    return (
        <section className="mt-4 border-t border-line pt-3 space-y-4 max-w-full overflow-hidden">
            <h3 className="text-base font-bold text-ink">
                {collapseChevron}
                Community Experience <span className="font-medium text-muted">({effectiveAggregate.count})</span>
            </h3>

            {!collapsed && (
                <>
                    <ExperienceBreakdown
                        aggregate={effectiveAggregate}
                        aspectLabels={aspectLabels}
                        editionCount={crossEdition && series ? series.reviewed_edition_count : undefined}
                        slotAfterMoodBreakdown={crossEdition ? null : typicalCard}
                        moodHeadline={crossEdition ? typicalCard : undefined}
                    />

                    <div className="flex items-center gap-2 text-[11px] border-t border-line pt-4">
                        <label className="text-ink-soft">Sort:</label>
                        <select
                            value={sort}
                            onChange={(e) => setSort(e.target.value as 'recent' | 'positive' | 'critical')}
                            className="border border-line px-1.5 py-0.5 text-[11px] bg-surface"
                        >
                            <option value="recent">Most recent</option>
                            <option value="positive">Most positive</option>
                            <option value="critical">Most critical</option>
                        </select>
                    </div>

                    <div className="max-w-full overflow-x-auto pb-2 -mx-1 px-1">
                        <div className="flex gap-4 divide-x divide-slate-200">
                            {reviews.map((r) => {
                                const meta = r.overall_sentiment ? SENTIMENT_META[r.overall_sentiment] : null;
                                const initials =
                                    r.reviewer_label
                                        .trim()
                                        .split(/\s+/)
                                        .map((w) => w[0])
                                        .slice(0, 2)
                                        .join('')
                                        .toUpperCase() || '?';
                                const tags = cardTags(r);
                                const shown = tags.slice(0, CARD_TAGS_SHOWN);
                                const extra = tags.length - shown.length;
                                return (
                                    <div key={r.id} className="w-56 shrink-0 space-y-1.5 pl-4 first:pl-0">
                                        <div className="flex items-center gap-2">
                                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-ink-soft">
                                                {initials}
                                            </span>
                                            <span className="text-sm font-medium text-ink truncate">{r.reviewer_label}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-xs text-ink-soft">
                                            {meta && <span title={meta.label}>{meta.emoji} {meta.label}</span>}
                                            {meta && <span className="text-slate-300">·</span>}
                                            <span>{new Date(r.created_at).toLocaleDateString()}</span>
                                        </div>
                                        {r.comment && (
                                            <p className="text-xs text-ink whitespace-pre-wrap break-words">{r.comment}</p>
                                        )}
                                        {tags.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5">
                                                {shown.map((t) => (
                                                    <span key={t.key} className={`rounded-full px-2 py-0.5 text-[11px] ${t.cls}`}>
                                                        {t.label}
                                                    </span>
                                                ))}
                                                {extra > 0 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => setExpandedReview(r)}
                                                        className="rounded-full bg-slate-100 text-ink-soft px-2 py-0.5 text-[11px] hover:bg-canvas"
                                                    >
                                                        +{extra} more
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                        {r.event_id !== eventId && (
                                            <Link
                                                to={`/event/${r.event_id}`}
                                                className="inline-block text-[9px] font-medium text-sky-600 hover:text-sky-700"
                                            >
                                                From {r.event_title} →
                                            </Link>
                                        )}
                                    </div>
                                );
                            })}
                            {reviews.length === 0 && !loading && (
                                <div className="text-xs text-ink-soft">No reviews to show.</div>
                            )}
                            {hasMore && (
                                <button
                                    onClick={() => loadPage(reviews.length, false)}
                                    disabled={loading}
                                    className="shrink-0 self-center pl-4 text-xs text-sky-700 hover:text-sky-900 font-medium whitespace-nowrap"
                                >
                                    {loading ? 'Loading…' : 'Load more'}
                                </button>
                            )}
                        </div>
                    </div>

                    {expandedReview && (
                        <ReviewDetailModal review={expandedReview} onClose={() => setExpandedReview(null)} />
                    )}
                </>
            )}
        </section>
    );
}
