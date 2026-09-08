import { useEffect, useState } from 'react';
import type { CalendarEvent } from '../types';
import { currencySymbol } from '../utils/currency';
import { fetchEventMessages } from '../api';
import { useCommunityExperience } from '../hooks/useCommunityExperience';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { isPriceSectionVisible } from '../utils/sectionVisibility';
import TagBadges from './TagBadges';
import { DiscountBadge } from './CardPriceBadges';
import SummaryHeader from './event-summary/SummaryHeader';
import PeopleProofRow from './event-summary/PeopleProofRow';
import ReviewOverviewCard from './event-summary/ReviewOverviewCard';
import LinksRow from './event-summary/LinksRow';
import SummaryMiniMap from './event-summary/SummaryMiniMap';
import SeriesRow from './event-summary/SeriesRow';
import EventActions from './event-summary/EventActions';

/** Detail tabs the summary can deep-link into. */
export type EventDetailTab = 'overview' | 'about' | 'location' | 'people' | 'reviews' | 'discussion';

interface Props {
    event: CalendarEvent;
    /** `page` renders inside the full event page (tabs follow below); `modal`
     * renders inside the event modal (a "See full details" link follows). */
    variant: 'page' | 'modal';
    shareUrl: string;
    /** Select/scroll to a detail tab. In the modal this navigates to the full
     * page; on the page it activates the tab. */
    onOpenTab: (tab: EventDetailTab, opts?: { anchor?: string }) => void;
    reviewOpenToken?: number;
    onRatingChanged?: () => void;
    eventHasReviews?: boolean;
    onPostMessage: () => void;
    onSuggestEdit?: () => void;
    /** Render the trailing inline action row. The full page hides it (a
     * persistent dock owns the actions); the modal keeps it. Defaults to true. */
    showActions?: boolean;
    /** Omit the identity header (image + date/title/time/location). The full
     * page renders that header above the tabs itself. Defaults to false. */
    omitHeader?: boolean;
}

function priceCompact(event: CalendarEvent): string | null {
    if (event.price_is_free) return 'Free';
    if (event.price_min == null || !event.price_currency) return null;
    const s = currencySymbol(event.price_currency);
    if (event.price_max != null && event.price_max !== event.price_min) {
        return `${s}${event.price_min}–${event.price_max}`;
    }
    return `${s}${event.price_min}`;
}

/**
 * The single reusable event summary shared unchanged by the full event page and
 * the event modal. Renders — in order — an optional image, the event identity,
 * tags, social proof, a review overview, series, a one-line about preview,
 * external links, an optional mini-map, and the action row that marks the end
 * of the summary. Callers append either detail tabs (page) or a "See full
 * details" link (modal) after it; the summary itself never branches on surface.
 */
export default function EventSummary({
    event,
    variant,
    shareUrl,
    onOpenTab,
    reviewOpenToken,
    onRatingChanged,
    eventHasReviews,
    onPostMessage,
    onSuggestEdit,
    showActions = true,
    omitHeader = false,
}: Props) {
    const end = new Date(event.end);
    const isPast = end.getTime() < Date.now();
    const { showPrices } = useFeatureFlags();
    const { series, crossEdition, aggregate } = useCommunityExperience(event.event_id, isPast);
    const [postsCount, setPostsCount] = useState(0);

    useEffect(() => {
        let cancelled = false;
        fetchEventMessages(event.event_id, { limit: 1, offset: 0 })
            .then((res) => { if (!cancelled) setPostsCount(res.total); })
            .catch(() => { if (!cancelled) setPostsCount(0); });
        return () => { cancelled = true; };
    }, [event.event_id]);

    const priceVisible = isPriceSectionVisible(event, showPrices);
    const price = priceVisible ? priceCompact(event) : null;
    const hasPromo = event.has_active_promo_codes;

    return (
        <div className="space-y-5">
            {!omitHeader && <SummaryHeader event={event} variant={variant} />}

            {/* Tags — single line, neutral grey; overflow collapses to a
                clickable "+x" that opens the About tag list. */}
            <TagBadges
                tags={event.tags}
                forceBadge
                neutral
                size="sm"
                fitWidth
                onOverflowClick={() => onOpenTab('about')}
            />

            {/* People / social proof */}
            <PeopleProofRow
                event={event}
                postsCount={postsCount}
                onOpenPosts={() => onOpenTab('discussion')}
            />

            {/* Review overview */}
            <ReviewOverviewCard
                aggregate={aggregate}
                crossEdition={crossEdition}
                onOpen={() => onOpenTab('reviews')}
            />

            {/* Price + discount — one line under the review section */}
            {(price || hasPromo) && (
                <div className="flex items-center gap-2 text-sm">
                    {price && <span className="font-semibold text-ink">{price}</span>}
                    {hasPromo && (
                        <button
                            type="button"
                            onClick={() => onOpenTab('about', { anchor: 'discounts' })}
                            aria-label="View discounts"
                        >
                            <DiscountBadge />
                        </button>
                    )}
                </div>
            )}

            {/* Series */}
            {series && (
                <SeriesRow
                    title={series.canonical_title}
                    onClick={() => onOpenTab('about', { anchor: 'series' })}
                />
            )}

            {/* About preview — label + a few lines with inline "…more" */}
            {event.description && (
                <div className="space-y-1">
                    <p className="text-sm font-semibold text-ink">About</p>
                    <p className="text-sm leading-relaxed text-ink-soft">
                        <span className="line-clamp-3">{event.description}</span>
                    </p>
                    <button
                        type="button"
                        onClick={() => onOpenTab('about')}
                        className="text-sm font-medium text-action hover:underline"
                    >
                        …more
                    </button>
                </div>
            )}

            {/* External links */}
            <LinksRow event={event} />

            {/* Mini-map */}
            <SummaryMiniMap event={event} onOpen={() => onOpenTab('location')} />

            {/* Actions — end of EventSummary (modal only; the page uses a dock) */}
            {showActions && (
                <EventActions
                    event={event}
                    isPast={isPast}
                    canReviewInline={isPast}
                    shareUrl={shareUrl}
                    reviewOpenToken={reviewOpenToken}
                    onRatingChanged={onRatingChanged}
                    eventHasReviews={eventHasReviews}
                    onPostMessage={onPostMessage}
                    onSuggestEdit={onSuggestEdit}
                />
            )}
        </div>
    );
}
