import type { ReactNode } from 'react';
import { useState } from 'react';
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
    /** Extra content rendered inside the card, below the reviews line. */
    bottomSlot?: ReactNode;
    // a11y / test hooks
    testId?: string;
    newDotTestId?: string;
    actionsTestId?: string;
}

const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

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
    bottomSlot,
    testId,
    newDotTestId,
    actionsTestId,
}: EventCardProps) {
    const {
        tagsPerCard,
        eventCardRsvpActionInAvatarRowEnabled,
        eventCardRsvpAndSaveStatsNextToActionEnabled,
    } = useFeatureFlags();
    const [imageFailed, setImageFailed] = useState(false);

    const start = new Date(event.start);
    const end = new Date(event.end);
    const sameDay = start.toDateString() === end.toDateString();
    const timeText = event.all_day
        ? (sameDay ? 'All day' : `Until ${fmtDate(new Date(end.getTime() - 1))}`)
        : (sameDay
            ? `${fmtTime(start)} – ${fmtTime(end)}`
            : `${fmtTime(start)} – ${fmtDate(end)}, ${fmtTime(end)}`);
    const dateText = event.all_day ? fmtDate(start) : `${fmtDate(start)} · ${fmtTime(start)}`;

    // "I'm going" sits bottom-right by the tags when the flag is on;
    // otherwise it joins Save in the top-right cluster.
    const actionList = actions ?? (['save', 'going'] as const);
    const wantsSave = showActions && actionList.includes('save');
    const wantsGoing = showActions && actionList.includes('going');
    const topActions: Array<'save' | 'going'> = [];
    if (wantsSave) topActions.push('save');
    if (wantsGoing && !eventCardRsvpActionInAvatarRowEnabled) topActions.push('going');
    const bottomGoing = wantsGoing && eventCardRsvpActionInAvatarRowEnabled;
    const priceVisible = showPrice && isPriceSectionVisible(event, false);
    const priceContent = priceVisible && (event.price_is_free || event.price_min != null);
    const location = shortLocation(event.location) ?? event.location;

    // The two-row header layout replaces the left date rail with an inline
    // date + title + Save top row; the schedule line then shows time only.
    const showLeftRail = dateRail && !dateHeaderRow;
    const scheduleShowsTime = showLeftRail || dateHeaderRow;

    const border = borderless
        ? 'shadow-md'
        : 'border border-card-line shadow-sm hover:border-line';
    const width = widthClass ? `${widthClass} shrink-0` : 'w-full';

    return (
        <div
            className={`group relative flex flex-col ${width} overflow-hidden rounded-card bg-surface text-left transition ${border} ${highlighted ? 'ring-1 ring-action' : ''}`}
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
            {/* Top section: left rail + image + title + actions */}
            <div className="pointer-events-none relative z-[1] flex min-w-0 flex-row px-3 py-3">
                {showLeftRail && (
                    <div className="flex shrink-0 self-stretch">
                        <EventDateRail start={start} sequence={dateSequence} tone={isPast ? 'neutral' : 'default'} />
                    </div>
                )}
                {showImage && !isPast && event.image_url && !imageFailed && (
                    <img
                        src={event.image_url}
                        alt=""
                        className="mr-3 h-20 w-20 shrink-0 rounded-card object-cover"
                        onError={() => setImageFailed(true)}
                        data-testid="event-card-image"
                    />
                )}
                <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col">
                    {dateHeaderRow ? (
                        <div className="flex items-start gap-2">
                            <span className="shrink-0 text-xs font-semibold text-ink-soft">{fmtDate(start)}</span>
                            <h3
                                className="min-w-0 flex-1 line-clamp-2 text-sm font-semibold leading-snug text-ink group-hover:text-action"
                                title={event.title}
                            >
                                {isNew && (
                                    <span
                                        // eslint-disable-next-line no-restricted-syntax -- small status dot (new event indicator) — allowed exception per frontend rules
                                        className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-action align-middle"
                                        aria-label="New"
                                        data-testid={newDotTestId}
                                    />
                                )}
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
                                        showStats={eventCardRsvpAndSaveStatsNextToActionEnabled}
                                        goingIconVariant={goingIconVariant}
                                    />
                                </div>
                            )}
                        </div>
                    ) : (
                        <>
                            {topActions.length > 0 && (
                                <div
                                    className="pointer-events-auto absolute top-2 right-2 z-[2] flex items-center gap-1"
                                    data-testid={actionsTestId}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                >
                                    <CardActionCluster
                                        eventId={event.event_id}
                                        isSavedFlag={isSavedFlag}
                                        isPast={isPast}
                                        include={topActions}
                                        showStats={eventCardRsvpAndSaveStatsNextToActionEnabled}
                                        goingIconVariant={goingIconVariant}
                                    />
                                </div>
                            )}
                            <h3
                                className={`min-w-0 truncate text-sm font-semibold leading-snug text-ink group-hover:text-action ${topActions.length > 0 ? 'pr-14' : ''}`}
                                title={event.title}
                            >
                                {isNew && (
                                    <span
                                        // eslint-disable-next-line no-restricted-syntax -- small status dot (new event indicator) — allowed exception per frontend rules
                                        className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-action align-middle"
                                        aria-label="New"
                                        data-testid={newDotTestId}
                                    />
                                )}
                                {event.title}
                            </h3>
                        </>
                    )}
                </div>
            </div>
            {/* Bottom section: time, location, price, avatars, tags, reviews */}
            <div className="pointer-events-none relative z-[1] flex min-w-0 flex-col px-3 pb-3">
                {!dateHeaderRow && isTrending && (
                    <div className="mt-1">
                        <span
                            className="inline-flex items-center bg-orange-50 px-1.5 py-px text-[11px] font-medium text-orange-400"
                            data-testid="trending-badge"
                            title="Trending"
                        >
                            Trending
                        </span>
                    </div>
                )}
                <p className="mt-1 flex items-center gap-1 text-xs text-ink-soft">
                    <span className="truncate">{scheduleShowsTime ? timeText : dateText}</span>
                </p>
                {location && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-soft">
                        <span className="truncate" title={event.location ?? undefined}>{location}</span>
                    </p>
                )}
                {(priceContent || event.has_active_promo_codes) && (
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-soft">
                        {priceContent && <PriceBadge event={event} />}
                        {event.has_active_promo_codes && <DiscountBadge />}
                    </p>
                )}
                {showAvatars && (
                    <div className="mt-2">
                        <AttendeeAvatarStack
                            eventId={event.event_id}
                            size="md"
                            friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                            hideIfOnlyCurrentUser={hideAvatarsIfOnlyCurrentUser}
                        />
                    </div>
                )}
                {((showTags && event.tags?.length > 0) || bottomGoing) && (
                    <div className="mt-1 flex items-center gap-2">
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
                                    showStats={eventCardRsvpAndSaveStatsNextToActionEnabled}
                                    goingIconVariant={goingIconVariant ?? 'hand'}
                                />
                            </div>
                        )}
                    </div>
                )}
                {showReviews && (
                    <div className="pointer-events-auto">
                        <CardReviewsLine eventId={event.event_id} showRatings={showRatings} />
                    </div>
                )}
                {bottomSlot && (
                    <div className="pointer-events-auto mt-2" onClick={(e) => e.stopPropagation()}>
                        {bottomSlot}
                    </div>
                )}
            </div>
        </div>
    );
}
