import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRatingAggregate, useInvalidateRatingAggregate } from '../context/RatingAggregatesContext';
import { useMyRating, useMyRatingsLoaded, useUpsertMyRating } from '../context/MyRatingsContext';
import RateEventModal from './RateEventModal';
import type { EventRating } from '../types';
import { trackRatingModalOpened, type RatingEntryPoint } from '../utils/tracking';
import { SENTIMENT_META } from '../utils/reviewSentiment';
import { Pencil } from 'lucide-react';

interface Props {
    eventId: string;
    appearance?: 'icon' | 'pill' | 'count' | 'preview';
    size?: 'sm' | 'md';
    stopPropagation?: boolean;
    className?: string;
    initialRating?: EventRating | null;
    /** When true, the icon shows as filled even if the current user hasn't rated yet. */
    eventHasReviews?: boolean;
    onRatingChanged?: (rating: EventRating | null) => void;
    /** Where in the UI this button lives — used as the Umami `entry_point` property. */
    entryPoint?: RatingEntryPoint;
    /** Bump this to a new value (e.g. a counter) to request the modal open — unlike a
     * boolean, a changing number reliably reopens the modal even if the previous
     * value was already "truthy" (e.g. clicking "Be the first to review" twice). */
    autoOpenToken?: number;
    /** When true, this is on the event detail page and should open a modal. When false/absent, should link to event detail page with community anchor. */
    isEventDetailPage?: boolean;
    /** When false, hides the numeric review count (used where the count is shown elsewhere, e.g. the Community Experience summary). Defaults to true. */
    showCount?: boolean;
    /** Whether the edition has already taken place. Upcoming editions can't be
     * reviewed, so the button renders disabled with an explanatory tooltip.
     * Defaults to true (reviewable) when unknown. */
    isPast?: boolean;
    /** Labels for the current user's selected aspect/audience tag ids. */
    reviewTagLabels?: Map<number, string>;
    /** Open the review modal here instead of navigating through event details. */
    inlineModal?: boolean;
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
    autoOpenToken,
    isEventDetailPage,
    showCount = true,
    isPast = true,
    reviewTagLabels,
    inlineModal = false,
}: Props) {
    const { user } = useAuth();
    const location = useLocation();
    const aggregate = useRatingAggregate(eventId);
    const invalidateAggregate = useInvalidateRatingAggregate();
    const myRatingFromCtx = useMyRating(eventId);
    const ratingsLoaded = useMyRatingsLoaded();
    const upsertMyRating = useUpsertMyRating();
    const [open, setOpen] = useState(false);
    const [showSignIn, setShowSignIn] = useState(false);
    const [localRating, setLocalRating] = useState<EventRating | null>(initialRating);

    // Auto-detect if on event detail page by checking pathname
    const isOnEventDetailPage = isEventDetailPage !== undefined
        ? isEventDetailPage
        : location.pathname.startsWith(`/event/${eventId}`);

    // Fires only on actual *changes* of autoOpenToken (not on mount unless a
    // token was already provided at mount) so repeated requests to open the
    // modal — e.g. clicking "Be the first to review" more than once — always
    // work, even if the modal was closed in between.
    const lastAutoOpenToken = useRef(autoOpenToken);
    useEffect(() => {
        if (autoOpenToken === undefined) return;
        if (lastAutoOpenToken.current === autoOpenToken) return;
        // Don't mark the token as handled until a signed-in user is actually
        // available — auth resolves asynchronously, so if this effect first
        // fires before it does, we must retry once `user` becomes truthy
        // rather than silently dropping the auto-open request.
        if (!user) return;
        lastAutoOpenToken.current = autoOpenToken;
        trackRatingModalOpened(entryPoint ?? 'notification', !!myRatingFromCtx);
        setOpen(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoOpenToken, user]);

    // Prefer context (loaded once for signed-in user) over local/initial state.
    const myRating: EventRating | null = myRatingFromCtx
        ? {
            id: myRatingFromCtx.id,
            event_id: myRatingFromCtx.event_id,
            overall_sentiment: myRatingFromCtx.overall_sentiment,
            aspect_scores: myRatingFromCtx.aspect_scores,
            aspect_tag_ids: myRatingFromCtx.aspect_tag_ids,
            audience_tag_ids: myRatingFromCtx.audience_tag_ids,
            comment: myRatingFromCtx.comment,
            comment_status: myRatingFromCtx.comment_status,
            is_anonymous: myRatingFromCtx.is_anonymous,
            status: myRatingFromCtx.status,
            created_at: myRatingFromCtx.created_at,
            updated_at: myRatingFromCtx.updated_at,
        }
        : localRating;

    const iconSizeClass = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4';
    const hasRated = !!myRating;
    const aggCount = aggregate?.count ?? 0;
    const hasAggregate = aggCount > 0;
    // `eventHasReviews` kept for backward-compat but aggregate from context is the source of truth.
    void eventHasReviews;
    // The reviewer's free-text comment is the only moderated part; surface its state subtly.
    const commentStatus = myRating?.comment_status;
    const dotColor = hasRated
        ? commentStatus === 'pending'
            ? 'bg-amber-400'
            : 'bg-sky-500'
        : '';

    // Read-only "count" appearance (event cards / map popups): just a comment
    // icon + review count, no CTA affordance. Nothing to show without reviews.
    if (appearance === 'count' && !hasAggregate) return null;

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (!user) {
            setShowSignIn((s) => !s);
            return;
        }
        const trackedEntryPoint = appearance === 'count' || appearance === 'preview' ? 'icon' : appearance;
        trackRatingModalOpened(entryPoint ?? trackedEntryPoint, !!myRating);
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

    const fillColor = hasAggregate || hasRated ? '#0ea5e9' : 'none';
    const strokeColor = hasAggregate || hasRated ? '#0284c7' : 'currentColor';

    // Speech-bubble "reviews" icon — no stars are shown anywhere.
    const ReviewIcon = (
        <svg viewBox="0 0 20 20" className={iconSizeClass} fill={fillColor} stroke={strokeColor} strokeWidth={1.5} style={{ pointerEvents: 'none' }}>
            <path d="M3 4.5h14v9H8.5L5 16.5V13.5H3z" strokeLinejoin="round" />
        </svg>
    );

    const tooltip = hasAggregate
        ? hasRated
            ? `${aggCount} review${aggCount !== 1 ? 's' : ''} — edit your review`
            : `${aggCount} review${aggCount !== 1 ? 's' : ''} — add yours`
        : hasRated
            ? 'Edit your review'
            : 'Be the first to review';

    const countText = showCount && hasAggregate ? String(aggCount) : null;

    const selectedTagIds = myRating
        ? [...myRating.aspect_tag_ids, ...myRating.audience_tag_ids]
        : [];
    const selectedTagLabels = selectedTagIds
        .map((tagId) => reviewTagLabels?.get(tagId))
        .filter((tagLabel): tagLabel is string => !!tagLabel);

    const previewContent = myRating?.overall_sentiment ? (
        <span className="block text-left">
            <span className="block text-[10px] font-semibold uppercase text-ink-soft">Your review</span>
            <span className="mt-1 line-clamp-2 block text-sm leading-5 text-ink">
                {SENTIMENT_META[myRating.overall_sentiment].emoji}{' '}
                <span className="font-medium">{SENTIMENT_META[myRating.overall_sentiment].label}</span>
                {myRating.comment && (
                    <span className="italic"> · “{myRating.comment}”</span>
                )}
            </span>
            {selectedTagLabels.length > 0 && (
                <span className="mt-2 flex flex-wrap items-center gap-2">
                    {selectedTagLabels.slice(0, 2).map((tagLabel, index) => (
                        <span key={`${selectedTagIds[index]}-${tagLabel}`} className="bg-emerald-50 px-3 py-1 text-xs font-medium text-success">
                            {tagLabel}
                        </span>
                    ))}
                    {selectedTagLabels.length > 2 && (
                        <span className="bg-canvas px-2 py-1 text-xs font-medium text-ink-soft">+{selectedTagLabels.length - 2}</span>
                    )}
                </span>
            )}
        </span>
    ) : (
        <span className="flex items-center gap-2 bg-action/5 px-3 py-2 text-sm font-medium text-action">
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Write a review
        </span>
    );

    if (appearance === 'preview' && !ratingsLoaded) {
        return <span className="block h-16 animate-pulse bg-canvas" aria-label="Loading your review" />;
    }

    // Common content for both button and link
    const buttonContent = appearance === 'preview' ? previewContent : appearance === 'pill' ? (
        <>
            <span className="relative inline-flex">
                {ReviewIcon}
                {dotColor && <span className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 ${dotColor}`} />}
            </span>
            {countText
                ? (
                    <span className="tabular-nums">
                        Reviews <span className="text-muted">({countText})</span>
                        {hasRated && commentStatus === 'pending' && (
                            <span className="ml-1.5 pl-1.5 border-l border-amber-300 text-[11px] text-amber-700">
                                Your comment pending
                            </span>
                        )}
                    </span>
                )
                : hasRated
                    ? (commentStatus === 'pending' ? 'Comment pending' : 'Your review')
                    : 'Review'}
        </>
    ) : appearance === 'count' ? (
        <>
            <span className={`tabular-nums font-medium text-ink-soft ${size === 'sm' ? 'text-[10px]' : 'text-xs'}`}>{aggCount}</span>
            <img src="/message.png" alt="" aria-hidden="true" className={iconSizeClass} />
        </>
    ) : (
        <>
            {ReviewIcon}
            {countText && (
                <span className={`tabular-nums font-medium text-ink ${size === 'sm' ? 'text-[10px]' : 'text-xs'}`}>{countText}</span>
            )}
            {dotColor && <span className={`absolute top-0 right-0 w-1.5 h-1.5 ${dotColor}`} />}
        </>
    );

    const buttonClasses = appearance === 'preview'
        ? `block w-full text-left ${className}`.trim()
        : appearance === 'pill'
            ? `text-xs px-3 py-1 transition flex items-center gap-1.5 border ${hasAggregate || hasRated ? 'text-sky-700 bg-sky-50 border-sky-200 hover:bg-sky-100' : 'text-ink-soft bg-surface border-line hover:bg-canvas'} ${className}`.trim()
            : appearance === 'count'
                ? `inline-flex items-center gap-1 text-ink-soft hover:text-ink ${className}`.trim()
                : `transition relative inline-flex items-center gap-0.5 ${size === 'sm' ? 'p-1' : 'p-1.5'} ${hasAggregate || hasRated ? 'text-sky-600 hover:text-sky-700' : 'text-slate-300 hover:text-ink-soft'} ${className}`.trim();

    // Upcoming editions can't be reviewed — hide the button entirely (except the
    // read-only "count" appearance, which is naturally empty).
    if (!isPast && appearance !== 'count') {
        return null;
    }

    // If not on event detail page, render as a link to the event detail page.
    // The read-only "count" appearance just views the reviews section; the
    // "Review" CTAs (pill/icon) target the `/review` deep-link route so they
    // auto-open the Rate modal on arrival — same as clicking Review on the
    // detail page itself.
    if (!isOnEventDetailPage && !inlineModal) {
        const linkTo = appearance === 'count'
            ? `/event/${eventId}#community`
            : `/event/${eventId}/review`;
        return (
            <span className="relative inline-flex" onMouseDown={stop} onPointerDown={stop} onClick={stop}>
                <Link
                    to={linkTo}
                    title={tooltip}
                    className={buttonClasses}
                >
                    {buttonContent}
                </Link>
            </span>
        );
    }

    const button =
        appearance === 'pill' ? (
            <button
                type="button"
                onClick={handleClick}
                onMouseDown={stop}
                onPointerDown={stop}
                title={tooltip}
                className={buttonClasses}
                aria-label={tooltip}
            >
                {buttonContent}
            </button>
        ) : (
            <button
                type="button"
                onClick={handleClick}
                onMouseDown={stop}
                onPointerDown={stop}
                title={tooltip}
                className={buttonClasses}
                aria-label={tooltip}
            >
                {buttonContent}
            </button>
        );

    return (
        <span className="relative inline-flex" onMouseDown={stop} onPointerDown={stop} onClick={stop}>
            {button}
            {showSignIn && !user && (
                <div
                    className="absolute z-50 top-full mt-2 right-0 w-56 border border-line bg-surface shadow-lg p-3 text-xs"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <p className="text-ink font-medium">Sign in to rate</p>
                    <p className="text-ink-soft mt-1">Share your feedback and help others find great events.</p>
                    <div className="mt-2 flex gap-2">
                        <Link
                            to={`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`}
                            className="flex-1 text-center bg-sky-600 text-white px-2 py-1 hover:bg-sky-700"
                        >
                            Sign in
                        </Link>
                        <button
                            onClick={() => setShowSignIn(false)}
                            className="border border-line text-ink-soft px-2 py-1 hover:bg-canvas"
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
