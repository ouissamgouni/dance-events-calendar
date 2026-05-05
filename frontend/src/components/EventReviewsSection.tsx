import { useEffect, useState, useCallback } from 'react';
import { fetchEventReviews, fetchRatingAggregate, fetchTagGroups } from '../api';
import type { EventRatingAggregate, EventReviewPublic, Tag } from '../types';
import RatingStars from './RatingStars';
import RatingDistribution from './RatingDistribution';

interface Props {
    eventId: string;
    /** Notifies parent when aggregate count is known (so the rate button can highlight). */
    onAggregateLoaded?: (agg: EventRatingAggregate | null) => void;
}

const PAGE_SIZE = 5;

export default function EventReviewsSection({ eventId, onAggregateLoaded }: Props) {
    const [aggregate, setAggregate] = useState<EventRatingAggregate | null>(null);
    const [reviews, setReviews] = useState<EventReviewPublic[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [sort, setSort] = useState<'recent' | 'highest' | 'lowest'>('recent');
    const [filterStars, setFilterStars] = useState<number | null>(null);
    const [reviewTags, setReviewTags] = useState<Tag[]>([]);

    const loadAggregate = useCallback(() => {
        fetchRatingAggregate(eventId)
            .then((a) => {
                setAggregate(a);
                onAggregateLoaded?.(a);
            })
            .catch(() => {
                setAggregate(null);
                onAggregateLoaded?.(null);
            });
    }, [eventId, onAggregateLoaded]);

    useEffect(() => {
        loadAggregate();
    }, [loadAggregate]);

    useEffect(() => {
        fetchTagGroups()
            .then((groups) => {
                const g = groups.find((x) => x.slug === 'review-tags');
                setReviewTags(g?.tags ?? []);
            })
            .catch(() => setReviewTags([]));
    }, []);

    const loadPage = useCallback(
        async (offset: number, replace: boolean) => {
            setLoading(true);
            try {
                const res = await fetchEventReviews(eventId, {
                    sort,
                    minStars: filterStars ?? undefined,
                    limit: PAGE_SIZE,
                    offset,
                });
                setReviews((prev) => (replace ? res.items : [...prev, ...res.items]));
                setHasMore(offset + res.items.length < res.total);
            } catch {
                if (replace) setReviews([]);
                setHasMore(false);
            } finally {
                setLoading(false);
            }
        },
        [eventId, sort, filterStars],
    );

    useEffect(() => {
        loadPage(0, true);
    }, [loadPage]);

    const tagLabel = (id: number) => reviewTags.find((t) => t.id === id)?.label ?? `Tag #${id}`;

    if (!aggregate || aggregate.count === 0) {
        return (
            <section className="mt-4 border-t border-slate-200 pt-3">
                <h3 className="text-xs font-semibold text-slate-700 mb-1.5 uppercase tracking-wide">Reviews</h3>
                <p className="text-[11px] text-slate-500">
                    No reviews yet. Be the first to rate this event!
                </p>
            </section>
        );
    }

    return (
        <section className="mt-4 border-t border-slate-200 pt-3 space-y-3 max-w-full overflow-hidden">
            <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Reviews</h3>
            <div className="flex flex-col sm:flex-row gap-3">
                <div className="sm:w-32 flex-shrink-0 text-center">
                    <div className="text-2xl font-semibold text-slate-800 tabular-nums leading-none">
                        {aggregate.average.toFixed(1)}
                    </div>
                    <div className="mt-0.5"><RatingStars value={aggregate.average} size="sm" /></div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                        {aggregate.count} review{aggregate.count !== 1 ? 's' : ''}
                    </div>
                </div>
                <div className="flex-1 min-w-0">
                    <RatingDistribution
                        distribution={aggregate.distribution}
                        total={aggregate.count}
                        onFilterStars={setFilterStars}
                        activeStars={filterStars}
                    />
                </div>
            </div>

            <div className="flex items-center gap-2 text-[11px]">
                <label className="text-slate-500">Sort:</label>
                <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as 'recent' | 'highest' | 'lowest')}
                    className="border border-slate-300 px-1.5 py-0.5 text-[11px] bg-white"
                >
                    <option value="recent">Most recent</option>
                    <option value="highest">Highest rated</option>
                    <option value="lowest">Lowest rated</option>
                </select>
                {filterStars != null && (
                    <button
                        onClick={() => setFilterStars(null)}
                        className="bg-sky-50 text-sky-700 border border-sky-200 px-2 py-0.5 hover:bg-sky-100"
                    >
                        ★ {filterStars}+ ✕
                    </button>
                )}
            </div>

            <div className="max-h-72 overflow-y-auto pr-1 -mr-1">
                <ul className="space-y-2">
                    {reviews.map((r) => (
                        <li key={r.id} className="border border-slate-200 bg-slate-50 p-2">
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5 min-w-0">
                                    <RatingStars value={r.stars} size="sm" />
                                    <span className="text-[11px] font-medium text-slate-700 truncate">{r.reviewer_label}</span>
                                </div>
                                <span className="text-[10px] text-slate-400 shrink-0">
                                    {new Date(r.created_at).toLocaleDateString()}
                                </span>
                            </div>
                            {r.comment && (
                                <p className="mt-1 text-[11px] text-slate-700 whitespace-pre-wrap break-words">{r.comment}</p>
                            )}
                            {r.review_tags.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {r.review_tags.map((t) => (
                                        <span
                                            key={t.id}
                                            className="bg-sky-50 text-sky-700 border border-sky-200 px-1.5 py-0.5 text-[10px]"
                                        >
                                            {tagLabel(t.id)}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </li>
                    ))}
                    {reviews.length === 0 && !loading && (
                        <li className="text-[11px] text-slate-500">No reviews match this filter.</li>
                    )}
                </ul>
                {hasMore && (
                    <button
                        onClick={() => loadPage(reviews.length, false)}
                        disabled={loading}
                        className="mt-2 text-[11px] text-sky-700 hover:text-sky-900 font-medium"
                    >
                        {loading ? 'Loading…' : 'Load more reviews'}
                    </button>
                )}
            </div>
        </section>
    );
}
