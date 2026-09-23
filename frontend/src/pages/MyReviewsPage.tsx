import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchAspectTagGroups, fetchAudienceTagGroups, fetchEventsByIds, fetchMyPendingReviews, fetchMyRatings } from '../api';
import type { CalendarEvent, EventRating, MyRating, PendingReview, TagGroup } from '../types';
import { useAuth } from '../context/AuthContext';
import { useUpsertMyRating } from '../context/MyRatingsContext';
import { useInvalidateRatingAggregate } from '../context/RatingAggregatesContext';
import RateEventModal from '../components/RateEventModal';
import EventReviewCard from '../components/EventReviewCard';
import { SENTIMENT_META } from '../utils/reviewSentiment';

type ReviewsTab = 'pending' | 'reviewed';

function MyReviewCard({ review, name }: { review: MyRating; name: string }) {
    const meta = review.overall_sentiment ? SENTIMENT_META[review.overall_sentiment] : null;
    const initials = name.trim().split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase() || '?';
    return (
        <li className="rounded-card border border-card-line bg-surface p-3">
            <div className="flex items-center gap-2 min-w-0">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas text-xs font-semibold text-ink-soft">{initials}</span>
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{name}{review.is_anonymous && <span className="ml-1 text-xs font-normal text-muted">· anonymous</span>}</div>
                    <div className="flex items-center gap-1.5 text-xs text-ink-soft">
                        {meta && <span>{meta.emoji} {meta.label}</span>}
                        {meta && <span aria-hidden="true">·</span>}
                        <span>{new Date(review.created_at).toLocaleDateString()}</span>
                    </div>
                </div>
            </div>
            {review.comment && <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm text-ink">{review.comment}{review.comment_status === 'pending' && <span className="ml-1 text-muted">(awaiting review)</span>}</p>}
            <Link to={`/event/${review.event_id}`} className="mt-2 inline-block text-xs font-medium text-action hover:underline">{review.event_title || 'View event'} →</Link>
        </li>
    );
}

function pendingReviewPlace(review: PendingReview): string {
    const parts = [review.event_location, review.event_city, review.event_country].filter((part): part is string => Boolean(part));
    return parts.filter((part, index) => !parts.slice(0, index).some((previous) => previous.toLocaleLowerCase().includes(part.toLocaleLowerCase()))).join(', ');
}

function labelsByTagId(groups: TagGroup[]): Map<number, string> {
    return new Map(groups.flatMap((group) => group.tags.map((tag) => [tag.id, tag.label] as const)));
}

function PendingReviewFallback({ review, onWrite }: { review: PendingReview; onWrite: () => void }) {
    const date = review.event_start ? new Date(review.event_start).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    const place = pendingReviewPlace(review);
    return (
        <li className="rounded-card border border-card-line bg-surface p-4">
            <h2 className="text-sm font-semibold text-ink">{review.event_title ?? 'Past event'}</h2>
            {(date || place) && <p className="mt-1 text-xs text-ink-soft">{[date, place].filter(Boolean).join(' · ')}</p>}
            {review.friend_proof && <p className="mt-2 text-xs text-ink-soft">Reviewed by {review.friend_proof}</p>}
            <button type="button" onClick={onWrite} className="mt-3 inline-flex min-h-11 items-center rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90">Write a review</button>
        </li>
    );
}

export default function MyReviewsPage() {
    const { user } = useAuth();
    const [params, setParams] = useSearchParams();
    const activeTab: ReviewsTab = params.get('tab') === 'reviewed' ? 'reviewed' : 'pending';
    const [pending, setPending] = useState<PendingReview[] | null>(null);
    const [eventsById, setEventsById] = useState<Map<string, CalendarEvent>>(new Map());
    const [reviewed, setReviewed] = useState<MyRating[] | null>(null);
    const [reviewTagLabels, setReviewTagLabels] = useState<Map<number, string>>(new Map());
    const [reviewing, setReviewing] = useState<PendingReview | null>(null);
    const upsertMyRating = useUpsertMyRating();
    const invalidateAggregate = useInvalidateRatingAggregate();
    const navigate = useNavigate();

    const load = useCallback(() => {
        if (!user) {
            setPending([]);
            setReviewed([]);
            return;
        }
        Promise.all([fetchMyPendingReviews(), fetchMyRatings()])
            .then(([pendingRows, reviewedRows]) => {
                setPending(pendingRows);
                setReviewed(reviewedRows);
                const eventIds = [...new Set([...pendingRows, ...reviewedRows].map((row) => row.event_id))];
                fetchEventsByIds(eventIds)
                    .then((events) => setEventsById(new Map(events.map((event) => [event.event_id, event]))))
                    .catch(() => setEventsById(new Map()));
            })
            .catch(() => {
                setPending([]);
                setReviewed([]);
            });
    }, [user]);
    useEffect(load, [load]);

    useEffect(() => {
        let cancelled = false;
        Promise.all([fetchAspectTagGroups(), fetchAudienceTagGroups()])
            .then(([aspectGroups, audienceGroups]) => {
                if (!cancelled) setReviewTagLabels(labelsByTagId([...aspectGroups, ...audienceGroups]));
            })
            .catch(() => {
                if (!cancelled) setReviewTagLabels(new Map());
            });
        return () => { cancelled = true; };
    }, []);

    if (!user) return <div className="mx-auto max-w-xl px-4 py-6 text-sm text-ink-soft"><Link to="/login?next=/reviews" className="text-action hover:underline">Sign in</Link> to manage your reviews.</div>;

    const handleSubmitted = (rating: EventRating) => {
        if (!reviewing) return;
        upsertMyRating(reviewing.event_id, rating);
        invalidateAggregate(reviewing.event_id);
        setPending((rows) => rows?.filter((row) => row.event_id !== reviewing.event_id) ?? []);
        setReviewing(null);
        fetchMyRatings().then(setReviewed).catch(() => { });
    };
    const handlePendingRatingChanged = (review: PendingReview, rating: EventRating | null) => {
        if (!rating) return;
        setPending((rows) => rows?.filter((row) => row.event_id !== review.event_id) ?? []);
        fetchMyRatings().then(setReviewed).catch(() => { });
    };
    const handleReviewedRatingChanged = (review: MyRating, rating: EventRating | null) => {
        if (!rating) {
            setReviewed((rows) => rows?.filter((row) => row.id !== review.id) ?? []);
            fetchMyPendingReviews().then(setPending).catch(() => { });
            return;
        }
        fetchMyRatings().then(setReviewed).catch(() => { });
    };
    const rows = activeTab === 'pending' ? pending : reviewed;

    return (
        <div className="mx-auto max-w-xl px-4 py-4">
            <h1 className="text-2xl font-bold text-ink">Reviews</h1>
            <div role="tablist" className="mt-3 grid grid-cols-2 border-b border-line">
                <button type="button" role="tab" aria-selected={activeTab === 'pending'} onClick={() => setParams({ tab: 'pending' }, { replace: true })} className={`border-b-2 py-3 text-sm font-medium ${activeTab === 'pending' ? 'border-action text-action' : 'border-transparent text-ink-soft'}`}>Pending {pending ? `(${pending.length})` : ''}</button>
                <button type="button" role="tab" aria-selected={activeTab === 'reviewed'} onClick={() => setParams({ tab: 'reviewed' }, { replace: true })} className={`border-b-2 py-3 text-sm font-medium ${activeTab === 'reviewed' ? 'border-action text-action' : 'border-transparent text-ink-soft'}`}>Reviewed {reviewed ? `(${reviewed.length})` : ''}</button>
            </div>
            {rows === null ? <p className="py-8 text-sm text-muted">Loading...</p> : activeTab === 'pending' ? (
                pending!.length === 0 ? <p className="py-8 text-sm text-ink-soft">You are all caught up.</p> : <ul className="mt-3 space-y-3">{pending!.map((review) => {
                    const event = eventsById.get(review.event_id);
                    return event ? (
                        <li key={review.event_id}>
                            <EventReviewCard
                                event={event}
                                variant="pending"
                                onOpen={(selectedEvent) => navigate(`/event/${selectedEvent.event_id}`)}
                                friendProof={review.friend_proof}
                                onRatingChanged={(rating) => handlePendingRatingChanged(review, rating)}
                                testId="pending-review-card"
                            />
                        </li>
                    ) : <PendingReviewFallback key={review.event_id} review={review} onWrite={() => setReviewing(review)} />;
                })}</ul>
            ) : reviewed!.length === 0 ? <p className="py-8 text-sm text-ink-soft">You haven't reviewed any events yet.</p> : <ul className="mt-3 space-y-3">{reviewed!.map((review) => {
                const event = eventsById.get(review.event_id);
                return event ? (
                    <li key={review.id}>
                        <EventReviewCard
                            event={event}
                            variant="reviewed"
                            onOpen={(selectedEvent) => navigate(`/event/${selectedEvent.event_id}`)}
                            initialRating={review}
                            reviewTagLabels={reviewTagLabels}
                            onRatingChanged={(rating) => handleReviewedRatingChanged(review, rating)}
                            testId="reviewed-event-card"
                        />
                    </li>
                ) : <MyReviewCard key={review.id} review={review} name={user.name ?? 'You'} />;
            })}</ul>}
            {reviewing && <RateEventModal eventId={reviewing.event_id} initialRating={null} onClose={() => setReviewing(null)} onSubmitted={handleSubmitted} />}
        </div>
    );
}
