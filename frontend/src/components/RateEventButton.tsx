import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRatingAggregate, useInvalidateRatingAggregate } from '../context/RatingAggregatesContext';
import { useMyRating, useUpsertMyRating } from '../context/MyRatingsContext';
import RateEventModal from './RateEventModal';
import type { EventRating } from '../types';
import { trackRatingModalOpened, type RatingEntryPoint } from '../utils/tracking';

interface Props {
    eventId: string;
    appearance?: 'icon' | 'pill';
    size?: 'sm' | 'md';
    stopPropagation?: boolean;
    className?: string;
    initialRating?: EventRating | null;
    /** When true, the icon shows as filled even if the current user hasn't rated yet. */
    eventHasReviews?: boolean;
    onRatingChanged?: (rating: EventRating | null) => void;
    /** Where in the UI this button lives — used as the Umami `entry_point` property. */
    entryPoint?: RatingEntryPoint;
}

export default function RateEventButton({
    eventId,
    appearance = 'icon',
    size = 'md',
    stopPropagation = false,
    className = '',
    initialRating = null,
    eventHasReviews = false,
    onRatingChanged,
    entryPoint,
}: Props) {
    const { user } = useAuth();
    const location = useLocation();
    const aggregate = useRatingAggregate(eventId);
    const invalidateAggregate = useInvalidateRatingAggregate();
    const myRatingFromCtx = useMyRating(eventId);
    const upsertMyRating = useUpsertMyRating();
    const [open, setOpen] = useState(false);
    const [showSignIn, setShowSignIn] = useState(false);
    const [localRating, setLocalRating] = useState<EventRating | null>(initialRating);

    // Prefer context (loaded once for signed-in user) over local/initial state.
    const myRating: EventRating | null = myRatingFromCtx
        ? {
            id: myRatingFromCtx.id,
            event_id: myRatingFromCtx.event_id,
            stars: myRatingFromCtx.stars,
            comment: myRatingFromCtx.comment,
            review_tag_ids: myRatingFromCtx.review_tag_ids,
            is_anonymous: myRatingFromCtx.is_anonymous,
            status: myRatingFromCtx.status,
            created_at: myRatingFromCtx.created_at,
            updated_at: myRatingFromCtx.updated_at,
        }
        : localRating;

    const iconSizeClass = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4';
    const hasRated = !!myRating;
    const status = myRating?.status;
    const aggCount = aggregate?.count ?? 0;
    const aggAvg = aggregate?.average ?? 0;
    const hasAggregate = aggCount > 0;
    // `eventHasReviews` kept for backward-compat but aggregate from context is the source of truth.
    void eventHasReviews;
    const dotColor =
        status === 'approved'
            ? 'bg-sky-500'
            : status === 'rejected'
                ? 'bg-slate-400'
                : status === 'pending'
                    ? 'bg-amber-400'
                    : '';

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (!user) {
            setShowSignIn((s) => !s);
            return;
        }
        trackRatingModalOpened(entryPoint ?? appearance, !!myRating);
        setOpen(true);
    };

    const stop = (e: React.MouseEvent) => {
        e.stopPropagation();
    };
    // mark stopPropagation as intentionally read so eslint stays happy
    void stopPropagation;

    const onChanged = (next: EventRating | null) => {
        setLocalRating(next);
        upsertMyRating(eventId, next);
        invalidateAggregate(eventId);
        onRatingChanged?.(next);
    };

    const fillColor = hasAggregate || hasRated ? '#f59e0b' : 'none';
    const strokeColor = hasAggregate || hasRated ? '#d97706' : 'currentColor';

    const StarIcon = (
        <svg viewBox="0 0 20 20" className={iconSizeClass} fill={fillColor} stroke={strokeColor} strokeWidth={1.5} style={{ pointerEvents: 'none' }}>
            <path d="M10 1.6l2.6 5.3 5.9.9-4.3 4.2 1 5.9L10 15.1 4.8 17.9l1-5.9L1.5 7.8l5.9-.9L10 1.6z" />
        </svg>
    );

    const tooltip = hasAggregate
        ? hasRated
            ? `Rated ${aggAvg.toFixed(1)} from ${aggCount} review${aggCount !== 1 ? 's' : ''} — edit your rating (${status})`
            : `Rated ${aggAvg.toFixed(1)} from ${aggCount} review${aggCount !== 1 ? 's' : ''}`
        : hasRated
            ? `Edit your rating (${status})`
            : 'Rate this event';

    const scoreText = hasAggregate ? aggAvg.toFixed(1) : null;

    const button =
        appearance === 'pill' ? (
            <button
                type="button"
                onClick={handleClick}
                onMouseDown={stop}
                onPointerDown={stop}
                title={tooltip}
                className={`text-xs px-3 py-1 transition flex items-center gap-1.5 border ${hasAggregate || hasRated ? 'text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100' : 'text-slate-600 bg-white border-slate-300 hover:bg-slate-50'} ${className}`.trim()}
                aria-label={tooltip}
            >
                <span className="relative inline-flex">
                    {StarIcon}
                    {dotColor && <span className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 ${dotColor}`} />}
                </span>
                {scoreText
                    ? (
                        <span className="tabular-nums">
                            {scoreText} <span className="text-slate-400">({aggCount})</span>
                            {hasRated && (
                                <span className="ml-1.5 pl-1.5 border-l border-amber-300 text-[11px] text-amber-700">
                                    {status === 'pending' ? 'Your review pending' : status === 'rejected' ? 'Your review rejected' : 'Edit your review'}
                                </span>
                            )}
                        </span>
                    )
                    : hasRated
                        ? (status === 'pending' ? 'Pending review' : status === 'rejected' ? 'Rating rejected' : 'Edit rating')
                        : 'Rate'}
            </button>
        ) : (
            <button
                type="button"
                onClick={handleClick}
                onMouseDown={stop}
                onPointerDown={stop}
                title={tooltip}
                className={`transition relative inline-flex items-center gap-0.5 ${size === 'sm' ? 'p-1' : 'p-1.5'} ${hasAggregate || hasRated ? 'text-amber-600 hover:text-amber-700' : 'text-slate-300 hover:text-slate-500'} ${className}`.trim()}
                aria-label={tooltip}
            >
                {StarIcon}
                {scoreText && (
                    <span className={`tabular-nums font-medium text-slate-700 ${size === 'sm' ? 'text-[10px]' : 'text-xs'}`}>{scoreText}</span>
                )}
                {dotColor && <span className={`absolute top-0 right-0 w-1.5 h-1.5 ${dotColor}`} />}
            </button>
        );

    return (
        <span className="relative inline-flex" onMouseDown={stop} onPointerDown={stop} onClick={stop}>
            {button}
            {showSignIn && !user && (
                <div
                    className="absolute z-50 top-full mt-2 right-0 w-56 border border-slate-200 bg-white shadow-lg p-3 text-xs"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <p className="text-slate-700 font-medium">Sign in to rate</p>
                    <p className="text-slate-500 mt-1">Share your feedback and help others find great events.</p>
                    <div className="mt-2 flex gap-2">
                        <Link
                            to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
                            className="flex-1 text-center bg-sky-600 text-white px-2 py-1 hover:bg-sky-700"
                        >
                            Sign in
                        </Link>
                        <button
                            onClick={() => setShowSignIn(false)}
                            className="border border-slate-300 text-slate-600 px-2 py-1 hover:bg-slate-50"
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}
            {open && user && (
                <RateEventModal
                    eventId={eventId}
                    initialRating={myRating}
                    onClose={() => setOpen(false)}
                    onSubmitted={(r) => onChanged(r)}
                    onDeleted={() => onChanged(null)}
                />
            )}
        </span>
    );
}
