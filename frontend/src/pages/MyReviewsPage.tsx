import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchMyRatings } from '../api';
import type { MyRating } from '../types';
import { useAuth } from '../context/AuthContext';
import { SENTIMENT_META } from '../utils/reviewSentiment';

/** One review card, mirroring the Tribe "Following Reviews" card layout so
 * both review surfaces read the same. */
function MyReviewCard({ review, name }: { review: MyRating; name: string }) {
    const meta = review.overall_sentiment ? SENTIMENT_META[review.overall_sentiment] : null;
    const initials = name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
    return (
        <li className="border border-slate-200 bg-white p-3">
            <div className="flex items-center gap-2 min-w-0">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                    {initials}
                </span>
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">
                        {name}
                        {review.is_anonymous && <span className="ml-1 text-xs font-normal text-slate-400">· anonymous</span>}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        {meta && <span>{meta.emoji} {meta.label}</span>}
                        {meta && <span className="text-slate-300">·</span>}
                        <span>{new Date(review.created_at).toLocaleDateString()}</span>
                    </div>
                </div>
            </div>
            {review.comment && (
                <p className="mt-2 text-sm text-slate-700 whitespace-pre-wrap break-words line-clamp-4">
                    {review.comment}
                    {review.comment_status === 'pending' && (
                        <span className="ml-1 text-slate-400">(awaiting review)</span>
                    )}
                </p>
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

/** /mine/reviews — "My Reviews": the ratings the viewer has written. Extracted
 * from the old Settings "My Ratings" section. */
export default function MyReviewsPage() {
    const { user } = useAuth();
    const [myRatings, setMyRatings] = useState<MyRating[] | null>(null);

    useEffect(() => {
        if (!user) {
            setMyRatings([]);
            return;
        }
        fetchMyRatings().then(setMyRatings).catch(() => setMyRatings([]));
    }, [user]);

    if (!user) {
        return (
            <div className="mx-auto max-w-xl px-4 py-6 text-xs text-slate-600">
                <Link to="/login" className="text-blue-600 hover:underline">Sign in</Link> to see the reviews you've written.
            </div>
        );
    }

    const name = user.name ?? 'You';

    return (
        <div className="mx-auto max-w-xl px-4 py-4">
            <h1 className="mb-3 text-sm font-semibold text-slate-900">My Reviews</h1>
            {myRatings === null ? (
                <p className="text-sm text-slate-400">Loading…</p>
            ) : myRatings.length === 0 ? (
                <p className="text-sm text-slate-500">You haven't rated any events yet.</p>
            ) : (
                <ul className="space-y-2">
                    {myRatings.map((r) => <MyReviewCard key={r.id} review={r} name={name} />)}
                </ul>
            )}
        </div>
    );
}
