import type { ReactNode } from 'react';
import { useState } from 'react';
import { Clock, MapPin } from 'lucide-react';
import type { CalendarEvent } from '../types';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { isPriceSectionVisible } from '../utils/sectionVisibility';
import { shortLocation } from '../utils/locationShort';
import EventDateRail from './EventDateRail';
import AttendeeAvatarStack from './AttendeeAvatarStack';
import TagBadges from './TagBadges';
import CardReviewsLine from './CardReviewsLine';
import CardActionCluster from './CardActionCluster';
import { PriceBadge, DiscountBadge } from './CardPriceBadges';

export interface EventCardProps {
    event: CalendarEvent;
    onOpen: (event: CalendarEvent) => void;
    onHover?: (eventId: string | null) => void;
    // Layout
    /** Render the date on a left rail (date-first layout). Default true. */
    dateRail?: boolean;
    /** Two-row header layout: date + title + Save on the top row, the rest
     * below full-width. Used by the For You rails; overrides the left rail. */
    dateHeaderRow?: boolean;
    /** Allow the title to wrap to two lines (line-clamp-2) instead of a
     * single truncated line. Used by the map previews. */
    twoLineTitle?: boolean;
    /** Order-number badge shown inside the date rail (e.g. map journeys). */
    dateSequence?: number;
    /** Show the event image thumbnail when available. Default true. */
    showImage?: boolean;
    /** Fixed width (e.g. "w-[224px]") for horizontal-scroll tiles. Full-width row when omitted. */
    widthClass?: string;
    /** Drop the border + shadow (bottom-sheet previews). */
    borderless?: boolean;
    highlighted?: boolean;
    // Element toggles
    showAvatars?: boolean;
    showTags?: boolean;
    showReviews?: boolean;
    showPrice?: boolean;
    showActions?: boolean;
    /** Which actions to offer (Save / I'm going). Defaults to both. */
    actions?: ReadonlyArray<'save' | 'going'>;
    /** Icon style for the going button in the action cluster. */
    goingIconVariant?: 'hand' | 'person';
    // Context
    isPast?: boolean;
    isNew?: boolean;
    isTrending?: boolean;
    followingBadgeEnabled?: boolean;
    showRatings?: boolean;
    isSavedFlag?: boolean;
    hideAvatarsIfOnlyCurrentUser?: boolean;
    tagsAsBadge?: boolean;
    maxTags?: number;
    // Slots
    /** Content rendered full-width at the very top of the card, above the
     * date/image row (e.g. the Tribe face-first avatar stack). */
    headerSlot?: ReactNode;
    /** Extra content rendered inside the card, below the reviews line. */
    bottomSlot?: ReactNode;
    // a11y / test hooks
    testId?: string;
    newDotTestId?: string;
    actionsTestId?: string;
}

const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
// End date drops the month when it lands in the same month/year as the start.
const fmtEndDate = (start: Date, end: Date) => end.toLocaleDateString(
    undefined,
    start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()
        ? { weekday: 'short', day: 'numeric' }
        : { weekday: 'short', month: 'short', day: 'numeric' },
);

/**
 * Unified event card: explorer-style content with a left date rail. Shared
 * by My Events (lists + map previews), the explorer map preview, and the
 * "You might like" / "New" rails. Toggle props keep each surface lean while
 * the composition (avatars, tags, reviews, actions) stays in one place.
 */
export default function EventCard({
    event,
    onOpen,
    onHover,
    dateRail = true,
    dateHeaderRow = false,
    twoLineTitle = true,
    dateSequence,
    showImage = true,
    widthClass,
    borderless = false,
    highlighted = false,
    showAvatars = true,
    showTags = true,
    showReviews = true,
    showPrice = true,
    showActions = true,
    actions,
    goingIconVariant,
    isPast = false,
    isNew = false,
    isTrending = false,
    followingBadgeEnabled = false,
    showRatings = false,
    isSavedFlag = false,
    hideAvatarsIfOnlyCurrentUser = false,
    tagsAsBadge = false,
    maxTags,
    headerSlot,
    bottomSlot,
    testId,
    newDotTestId,
    actionsTestId,
}: EventCardProps) {
    const {
        tagsPerCard,
        eventCardImgoingLocationBottomEnabled,
        eventCardImgoingShowStatsEnabled,
        eventCardSaveShowStatsEnabled,
        eventCardShowTimeLocationIconsEnabled,
    } = useFeatureFlags();
    const [imageFailed, setImageFailed] = useState(false);

    const start = new Date(event.start);
    const end = new Date(event.end);
    const sameDay = start.toDateString() === end.toDateString();
    const timeText = event.all_day
        ? (sameDay ? 'All day' : `Until ${fmtEndDate(start, new Date(end.getTime() - 1))}`)
        : (sameDay
            ? `${fmtTime(start)} – ${fmtTime(end)}`
            : `${fmtTime(start)} – ${fmtEndDate(start, end)}, ${fmtTime(end)}`);
    const dateText = event.all_day ? fmtDate(start) : `${fmtDate(start)} · ${fmtTime(start)}`;

    // "I'm going" sits bottom-right by the tags when the flag is on;
    // otherwise it joins Save in the top-right cluster.
    const actionList = actions ?? (['save', 'going'] as const);
    const wantsSave = showActions && actionList.includes('save');
    const wantsGoing = showActions && actionList.includes('going');
    const topActions: Array<'save' | 'going'> = [];
    if (wantsSave) topActions.push('save');
    if (wantsGoing && !eventCardImgoingLocationBottomEnabled) topActions.push('going');
    const bottomGoing = wantsGoing && eventCardImgoingLocationBottomEnabled;
    const priceVisible = showPrice && isPriceSectionVisible(event, false);
    const priceContent = priceVisible && (event.price_is_free || event.price_min != null);
    const location = shortLocation(event.location) ?? event.location;

    // Discount + trending badges render as labels inside the card body.
    const discountVisible = showPrice && !!event.has_active_promo_codes;

    // The two-row header layout replaces the left date rail with an inline
    // date + title + Save top row; the schedule line then shows time only.
    const showLeftRail = dateRail && !dateHeaderRow;
    const scheduleShowsTime = showLeftRail || dateHeaderRow;

    const border = borderless
        ? ''
        : 'border border-card-line shadow-sm hover:border-line';
    const rounding = 'rounded-card';
    const width = widthClass ? `${widthClass} shrink-0` : 'w-full';
    const imageVisible = showImage && !isPast && !!event.image_url && !imageFailed;

    // Shared building blocks so the two header layouts (left rail vs. two-row)
    // compose the same content without duplication.
    const scheduleLine = (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-ink-soft">
            {eventCardShowTimeLocationIconsEnabled && <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className="truncate">{scheduleShowsTime ? timeText : dateText}</span>
        </p>
    );
    const locationLine = location ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-ink-soft">
            {eventCardShowTimeLocationIconsEnabled && <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className="truncate" title={event.location ?? undefined}>{location}</span>
        </p>
    ) : null;
    const priceLine = priceContent ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-soft">
            <PriceBadge event={event} />
        </p>
    ) : null;
    // Trending + Discount labels sit together, discount to the right of
    // trending, in both the rail and two-row layouts.
    const popularityBadgesInner = (isTrending || discountVisible) ? (
        <>
            {isTrending && (
                <span
                    className="inline-flex items-center bg-orange-50 px-1.5 py-px text-[11px] font-medium text-orange-400"
                    data-testid="trending-badge"
                    title="Trending"
                >
                    Trending
                </span>
            )}
            {discountVisible && <DiscountBadge />}
        </>
    ) : null;
    const popularityBadges = popularityBadgesInner ? (
        <div className="mt-1 flex items-center gap-1">{popularityBadgesInner}</div>
    ) : null;
    const avatarsBlock = showAvatars ? (
        <div className="mt-2.5">
            <AttendeeAvatarStack
                eventId={event.event_id}
                size="md"
                friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                hideIfOnlyCurrentUser={hideAvatarsIfOnlyCurrentUser}
            />
        </div>
    ) : null;
    const tagsBlock = ((showTags && event.tags?.length > 0) || bottomGoing) ? (
        <div className="mt-1.5 flex items-center gap-2">
            <div className="min-w-0 flex-1">
                {showTags && event.tags?.length > 0 && (
                    <TagBadges
                        tags={event.tags}
                        maxVisible={maxTags ?? (tagsAsBadge ? 4 : tagsPerCard)}
                        forceBadge={tagsAsBadge}
                    />
                )}
            </div>
            {bottomGoing && (
                <div
                    className="pointer-events-auto shrink-0"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                >
                    <CardActionCluster
                        eventId={event.event_id}
                        isPast={isPast}
                        include={['going']}
                        showGoingStats={eventCardImgoingShowStatsEnabled}
                        goingIconVariant={goingIconVariant ?? 'hand'}
                    />
                </div>
            )}
        </div>
    ) : null;
    const reviewsBlock = showReviews ? (
        <div className="pointer-events-auto">
            <CardReviewsLine eventId={event.event_id} showRatings={showRatings} />
        </div>
    ) : null;
    const bottomSlotBlock = bottomSlot ? (
        <div className="pointer-events-auto mt-2" onClick={(e) => e.stopPropagation()}>
            {bottomSlot}
        </div>
    ) : null;
    const newDot = isNew ? (
        <span
            // eslint-disable-next-line no-restricted-syntax -- small status dot (new event indicator) — allowed exception per frontend rules
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-action align-middle"
            aria-label="New"
            data-testid={newDotTestId}
        />
    ) : null;

    return (
        <div
            className={`group relative flex flex-col ${width} overflow-hidden ${rounding} bg-surface text-left transition ${border} ${highlighted ? 'ring-1 ring-action' : ''}`}
            onMouseEnter={onHover ? () => onHover(event.event_id) : undefined}
            onMouseLeave={onHover ? () => onHover(null) : undefined}
            data-testid={testId}
        >
            <button
                type="button"
                aria-label={`Open ${event.title}`}
                onClick={() => onOpen(event)}
                className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-action/30"
            />
            {headerSlot && (
                <div
                    className="pointer-events-auto relative z-[1] px-4 pt-3"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                >
                    {headerSlot}
                </div>
            )}
            {dateHeaderRow ? (
                <>
                    {/* Two-row header: date + title + Save on top, rest below full-width. */}
                    <div className="pointer-events-none relative z-[1] flex min-w-0 flex-col px-4 py-3">
                        <div className="flex items-start gap-2.5">
                            <span className="flex shrink-0 flex-col items-center text-center leading-tight" aria-hidden="true">
                                <span className={isPast ? 'text-xs font-semibold text-ink-soft' : 'event-card-rail-weekday'}>
                                    {start.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
                                </span>
                                <span className={isPast ? 'text-xs font-semibold text-ink-soft' : 'event-card-rail-month'}>
                                    {start.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}
                                </span>
                                <span className={isPast ? 'text-sm font-semibold text-ink-soft' : 'event-card-rail-day'}>{start.getDate()}</span>
                            </span>
                            <h3
                                className="min-w-0 flex-1 line-clamp-2 text-sm font-semibold leading-snug text-ink group-hover:text-action"
                                title={event.title}
                            >
                                {newDot}
                                {event.title}
                            </h3>
                            {topActions.length > 0 && (
                                <div
                                    className="pointer-events-auto flex shrink-0 items-center gap-1"
                                    data-testid={actionsTestId}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                >
                                    <CardActionCluster
                                        eventId={event.event_id}
                                        isSavedFlag={isSavedFlag}
                                        isPast={isPast}
                                        include={topActions}
                                        showSaveStats={eventCardSaveShowStatsEnabled}
                                        showGoingStats={eventCardImgoingShowStatsEnabled}
                                        goingIconVariant={goingIconVariant}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="pointer-events-none relative z-[1] flex min-w-0 flex-col px-4 pb-3">
                        <div className="flex min-w-0 flex-row">
                            {imageVisible && (
                                <img
                                    src={event.image_url ?? undefined}
                                    alt=""
                                    className="mr-3 h-20 w-20 shrink-0 rounded-none object-cover"
                                    onError={() => setImageFailed(true)}
                                    data-testid="event-card-image"
                                />
                            )}
                            <div className="flex min-w-0 flex-1 flex-col">
                                {popularityBadgesInner && (
                                    <div className="flex items-center gap-1">{popularityBadgesInner}</div>
                                )}
                                {scheduleLine}
                                {locationLine}
                                {priceLine}
                                {avatarsBlock}
                            </div>
                        </div>
                        {tagsBlock}
                        {reviewsBlock}
                        {bottomSlotBlock}
                    </div>
                </>
            ) : (
                <div className="pointer-events-none relative z-[1] flex min-w-0 flex-row px-4 py-3">
                    {showLeftRail && (
                        <div className="flex shrink-0 self-stretch">
                            <EventDateRail
                                start={start}
                                sequence={dateSequence}
                                tone={isPast ? 'neutral' : 'default'}
                            />
                        </div>
                    )}
                    <div className={`relative z-[1] flex min-w-0 flex-1 flex-col ${showLeftRail ? 'pl-3' : ''}`}>
                        {topActions.length > 0 && (
                            <div
                                className="pointer-events-auto absolute top-0 right-0 z-[2] flex items-center gap-1"
                                data-testid={actionsTestId}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => e.stopPropagation()}
                            >
                                <CardActionCluster
                                    eventId={event.event_id}
                                    isSavedFlag={isSavedFlag}
                                    isPast={isPast}
                                    include={topActions}
                                    showSaveStats={eventCardSaveShowStatsEnabled}
                                    showGoingStats={eventCardImgoingShowStatsEnabled}
                                    goingIconVariant={goingIconVariant}
                                />
                            </div>
                        )}
                        {/* Top row: image + core details (title, time, location, price). */}
                        <div className="flex min-w-0 flex-row">
                            {imageVisible && (
                                <img
                                    src={event.image_url ?? undefined}
                                    alt=""
                                    className="mr-3 h-20 w-20 shrink-0 rounded-none object-cover"
                                    onError={() => setImageFailed(true)}
                                    data-testid="event-card-image"
                                />
                            )}
                            <div className={`flex min-w-0 flex-1 flex-col ${imageVisible ? 'min-h-[5rem] justify-between' : ''}`}>
                                <div className="min-w-0">
                                    <h3
                                        className={`min-w-0 ${twoLineTitle ? 'line-clamp-2' : 'truncate'} text-sm font-semibold leading-snug text-ink group-hover:text-action ${topActions.length > 0 ? 'pr-14' : ''}`}
                                        title={event.title}
                                    >
                                        {newDot}
                                        {event.title}
                                    </h3>
                                    {popularityBadges}
                                </div>
                                <div className="min-w-0">
                                    {scheduleLine}
                                    {locationLine}
                                    {imageVisible && priceLine}
                                </div>
                            </div>
                        </div>
                        {/* Full width beneath the image/content area. */}
                        {!imageVisible && priceLine}
                        {avatarsBlock}
                        {tagsBlock}
                        {reviewsBlock}
                        {bottomSlotBlock}
                    </div>
                </div>
            )}
        </div>
    );
}
