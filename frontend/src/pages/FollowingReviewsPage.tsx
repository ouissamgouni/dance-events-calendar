import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchFollowingReviews } from '../api';
import type { EventReviewPublic } from '../types';
import { useAuth } from '../context/AuthContext';
import { SENTIMENT_META } from '../utils/reviewSentiment';

function ReviewCard({ review }: { review: EventReviewPublic }) {
    const meta = review.overall_sentiment ? SENTIMENT_META[review.overall_sentiment] : null;
    const initials =
        review.reviewer_label.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
    const tags = [
        ...review.aspect_tags.map((t) => ({
            key: `a-${t.id}`,
            label: t.label,
            cls: t.polarity === 'negative' ? 'bg-orange-50 text-orange-800' : 'bg-green-50 text-success',
        })),
        ...review.audience_tags.map((t) => ({ key: `u-${t.id}`, label: t.label, cls: 'bg-slate-100 text-ink-soft' })),
    ];
    return (
        <li className="border border-line bg-surface p-3">
            <div className="flex items-center gap-2 min-w-0">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-ink-soft">
                    {initials}
                </span>
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{review.reviewer_label}</div>
                    <div className="flex items-center gap-1.5 text-xs text-ink-soft">
                        {meta && <span>{meta.emoji} {meta.label}</span>}
                        {meta && <span className="text-slate-300">·</span>}
                        <span>{new Date(review.created_at).toLocaleDateString()}</span>
                    </div>
                </div>
            </div>
            {review.comment && (
                <p className="mt-2 text-sm text-ink whitespace-pre-wrap break-words line-clamp-4">{review.comment}</p>
            )}
            {tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {tags.map((t) => (
                        <span key={t.key} className={`rounded-full px-2 py-0.5 text-[11px] ${t.cls}`}>{t.label}</span>
                    ))}
                </div>
            )}
            <Link
                to={`/event/${review.event_id}`}
                className="mt-2 inline-block text-[11px] font-medium text-sky-600 hover:text-sky-700"
            >
                {review.event_title || 'View event'} →
            </Link>
        </li>
    );
}

/** /tribe/reviews — "Following Reviews": reviews written by people the viewer
 * follows, newest-first. */
export default function FollowingReviewsPage() {
    const { user } = useAuth();
    const [items, setItems] = useState<EventReviewPublic[] | null>(null);

    useEffect(() => {
        if (!user) {
            setItems([]);
            return;
        }
        let cancelled = false;
        fetchFollowingReviews({ limit: 50 })
            .then((res) => { if (!cancelled) setItems(res.items); })
            .catch(() => { if (!cancelled) setItems([]); });
        return () => { cancelled = true; };
    }, [user]);

    if (!user) {
        return (
            <div className="mx-auto max-w-xl px-4 py-6 text-xs text-ink-soft">
                <Link to="/login" className="text-action hover:underline">Sign in</Link> to see reviews from people you follow.
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-xl px-4 py-4">
            <h1 className="mb-3 text-sm font-semibold text-ink">Reviews from people you follow</h1>
            {items === null ? (
                <p className="text-sm text-muted">Loading…</p>
            ) : items.length === 0 ? (
                <p className="text-sm text-ink-soft">
                    No reviews yet. When people you follow review events, they'll show up here.
                </p>
            ) : (
                <ul className="space-y-2">
                    {items.map((r) => <ReviewCard key={r.id} review={r} />)}
                </ul>
            )}
        </div>
    );
}
