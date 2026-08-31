import { useEffect, useState } from 'react';
import { Clock, MapPin } from 'lucide-react';
import type { CalendarEvent } from '../types';
import { currencySymbol } from '../utils/currency';
import { fetchEventMessages } from '../api';
import { useCommunityExperience } from '../hooks/useCommunityExperience';
import TagBadges from './TagBadges';
import DateBlock from './event-summary/DateBlock';
import PeopleProofRow from './event-summary/PeopleProofRow';
import ReviewOverviewCard from './event-summary/ReviewOverviewCard';
import LinksRow from './event-summary/LinksRow';
import SummaryMiniMap from './event-summary/SummaryMiniMap';
import SeriesRow from './event-summary/SeriesRow';
import EventActions from './event-summary/EventActions';

/** Detail tabs the summary can deep-link into. */
export type EventDetailTab = 'about' | 'location' | 'people' | 'reviews' | 'discussion';

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
}: Props) {
    const start = new Date(event.start);
    const end = new Date(event.end);
    const isPast = end.getTime() < Date.now();
    const { series, crossEdition, aggregate } = useCommunityExperience(event.event_id, isPast);
    const [postsCount, setPostsCount] = useState(0);

    useEffect(() => {
        let cancelled = false;
        fetchEventMessages(event.event_id, { limit: 1, offset: 0 })
            .then((res) => { if (!cancelled) setPostsCount(res.total); })
            .catch(() => { if (!cancelled) setPostsCount(0); });
        return () => { cancelled = true; };
    }, [event.event_id]);

    const timeFmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const dayFmt = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const sameDay = start.toDateString() === end.toDateString();
    const timeLine = event.all_day
        ? (sameDay ? 'All day' : `${dayFmt(start)} – ${dayFmt(end)}`)
        : `${timeFmt(start)} → ${sameDay ? '' : `${dayFmt(end)} · `}${timeFmt(end)}`;

    const locationText = variant === 'modal'
        ? [event.city, event.country].filter(Boolean).join(', ') || event.location
        : event.location;
    const price = priceCompact(event);

    return (
        <div className="space-y-3">
            {/* Optional image — omitted entirely when absent */}
            {event.image_url && (
                <img
                    src={event.image_url}
                    alt=""
                    className="h-[140px] w-full object-cover"
                />
            )}

            {/* Event identity */}
            <div className="flex gap-3">
                <DateBlock date={start} />
                <div className="min-w-0 flex-1 space-y-1">
                    <h2 className="text-xl font-bold leading-snug text-ink">{event.title}</h2>
                    <p className="flex items-center gap-1.5 text-xs text-ink-soft">
                        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 truncate">{timeLine}</span>
                    </p>
                    <div className="flex items-start justify-between gap-2 text-xs text-ink-soft">
                        {locationText && (
                            <span className="inline-flex min-w-0 items-center gap-1.5">
                                <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span className="min-w-0 truncate">{locationText}</span>
                            </span>
                        )}
                        <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                            {price && <span className="font-semibold text-ink">{price}</span>}
                            {event.has_active_promo_codes && (
                                <button
                                    type="button"
                                    onClick={() => onOpenTab('about', { anchor: 'discounts' })}
                                    className="inline-flex items-center rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-action transition hover:bg-blue-100"
                                >
                                    Promo codes
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Tags — single line, neutral grey, never wraps */}
            <TagBadges tags={event.tags} maxVisible={6} forceBadge neutral size="sm" singleLine />

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
