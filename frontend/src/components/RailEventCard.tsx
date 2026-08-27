import { useCallback, useState, type ReactNode } from 'react';
import type { CalendarEvent } from '../types';
import TagBadges from './TagBadges';
import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';
import AttendeeAvatarStack from './AttendeeAvatarStack';
import EventDateRail from './EventDateRail';
import { shortLocation } from '../utils/locationShort';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

interface RailEventCardProps {
    event: CalendarEvent;
    onClick: (event: CalendarEvent) => void;
    onHover?: (eventId: string | null) => void;
    highlighted?: boolean;
    isNew?: boolean;
    isTrending?: boolean;
    followingBadgeEnabled?: boolean;
    /** Accessible-label context ("you might like event", "trending event"). */
    contextLabel?: string;
    /** Test-id for the actions cluster. Defaults to "rail-card-actions". */
    actionsTestId?: string;
    /** Test-id for the "new" indicator. Defaults to "rail-card-new-dot". */
    newDotTestId?: string;
    /** Optional badge rendered inline next to the date, e.g. "Off map". */
    extraBadge?: ReactNode;
    /** "compact" strips the Save/Going CTAs, the attendee stack and any
     * secondary badges so the card reads as a quiet discovery tile (used
     * by the Trending trail). */
    variant?: 'default' | 'compact';
    /** When true and `variant='compact'`, re-adds tags + AttendeeAvatarStack
     * (still keeps CTAs hidden). Driven by `trendingTrailRichEnabled`. */
    compactShowExtras?: boolean;
    /** Overrides the feature-flag `tagsPerCard` cap for the tag badges. */
    maxTags?: number;
    /** Forces badge rendering even when the `tagAsBadge` flag is off. */
    forceTagBadge?: boolean;
    /** Light-blue accent surface (onboarding "In your area" sample). */
    accent?: boolean;
    /** Overrides the default card width utility class. */
    widthClass?: string;
    /** Shows an event-list-style date column on the left. */
    dateRail?: boolean;
    /** Keeps tag badges on a single line, clipping overflow to a "+x". */
    tagSingleLine?: boolean;
    /** Group slugs whose tags sort first in the badge row. */
    tagPriorityGroups?: string[];
    /** Forces colored tag badges regardless of the feature flag. */
    forceTagColored?: boolean;
    /** Full-width list treatment used by My Events. */
    presentation?: 'rail' | 'my-events';
    /** Context-owned controls rendered without triggering the card. */
    actions?: ReactNode;
    /** Hide the avatar track when the viewer is the only attendee. */
    hideIfOnlyCurrentUser?: boolean;
    /** Past-list treatment: neutral date rail, no image, and no social metadata. */
    pastPresentation?: boolean;
    /** Content rendered below My Events metadata with its own interaction target. */
    supplementalContent?: ReactNode;
}

function formatRailDate(value: string): string {
    const date = new Date(value);
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// Titles render inside a fixed-width flex column with CSS `truncate`; the
// JS clamp used to be tight (22 chars) which cut off common event names
// well before the ellipsis width. Bumping to 40 lets the column absorb
// most reasonable titles and leaves the CSS truncation as the true limit.
function truncateText(value: string, maxLength = 40): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

/**
 * Shared card used by all Home-page rails (For you, Trending) so the
 * scroll rows look and behave identically regardless of the source
 * lens. Individual rails still own the outer scroll container, header,
 * and per-card decoration flags.
 */
export default function RailEventCard({
    event,
    onClick,
    onHover,
    highlighted = false,
    isNew = false,
    isTrending = false,
    followingBadgeEnabled = false,
    contextLabel = 'event',
    actionsTestId = 'rail-card-actions',
    newDotTestId = 'rail-card-new-dot',
    extraBadge,
    variant = 'default',
    compactShowExtras = false,
    maxTags,
    forceTagBadge = false,
    accent = false,
    widthClass,
    dateRail = false,
    tagSingleLine = false,
    tagPriorityGroups,
    forceTagColored = false,
    presentation = 'rail',
    actions,
    hideIfOnlyCurrentUser = false,
    pastPresentation = false,
    supplementalContent,
}: RailEventCardProps) {
    const { tagsPerCard } = useFeatureFlags();
    const [imageFailed, setImageFailed] = useState(false);
    const start = new Date(event.start);
    const startLabel = formatRailDate(event.start);
    const label = `Open ${event.title}, ${contextLabel} on ${startLabel}`;
    const title = truncateText(event.title);
    const location = shortLocation(event.location);
    const compact = variant === 'compact';
    const showExtras = !compact || compactShowExtras;
    const cardSize = widthClass ?? (dateRail ? 'w-[224px]' : compact ? 'w-[208px]' : 'w-[224px]');
    const surface = accent
        ? 'border-blue-200 bg-blue-50 hover:bg-blue-100'
        : 'border-card-line bg-surface hover:bg-canvas';

    const handleMouseEnter = useCallback(() => onHover?.(event.event_id), [onHover, event.event_id]);
    const handleMouseLeave = useCallback(() => onHover?.(null), [onHover]);

    if (presentation === 'my-events') {
        const time = event.all_day
            ? 'All day'
            : start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return (
            <div
                className="group relative flex min-h-28 w-full overflow-hidden rounded-card border border-card-line bg-surface text-left shadow-sm transition hover:border-line focus-within:ring-2 focus-within:ring-action/30"
                data-testid="my-events-row"
            >
                <button
                    type="button"
                    aria-label={label}
                    onClick={() => onClick(event)}
                    className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-action/30"
                />
                <div className="pointer-events-none relative z-[1] flex shrink-0 self-stretch">
                    <EventDateRail start={start} tone={pastPresentation ? 'neutral' : 'default'} />
                </div>
                {!pastPresentation && event.image_url && !imageFailed && (
                    <img
                        src={event.image_url}
                        alt=""
                        className="my-3 ml-3 h-20 w-20 shrink-0 rounded-card object-cover"
                        onError={() => setImageFailed(true)}
                        data-testid="my-events-row-image"
                    />
                )}
                <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col justify-center px-3 py-3">
                    <h3 className="truncate text-sm font-semibold text-ink group-hover:text-action sm:text-base" title={event.title}>{event.title}</h3>
                    <p className="mt-1 truncate text-sm text-ink-soft">{[time, location].filter(Boolean).join(' · ')}</p>
                    {!pastPresentation && <div className="mt-2 flex min-h-6 items-center gap-2">
                        <AttendeeAvatarStack
                            eventId={event.event_id}
                            size="md"
                            friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                            hideIfOnlyCurrentUser={hideIfOnlyCurrentUser}
                        />
                        {actions && (
                            <div
                                className="ml-auto flex items-center gap-1"
                                onClick={(clickEvent) => clickEvent.stopPropagation()}
                                onKeyDown={(keyEvent) => keyEvent.stopPropagation()}
                            >
                                {actions}
                            </div>
                        )}
                    </div>}
                    {supplementalContent && (
                        <div className="pointer-events-auto mt-3" onClick={(clickEvent) => clickEvent.stopPropagation()}>
                            {supplementalContent}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div
            className={`group relative flex ${cardSize} shrink-0 flex-col border ${surface} text-left transition ${dateRail ? 'rounded-r-card' : 'rounded-card px-2.5 py-2.5'} ${highlighted ? 'ring-1 ring-action' : ''}`}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            {!compact && (
                <div
                    className="absolute top-1 right-1 z-10 flex items-center gap-1"
                    data-testid={actionsTestId}
                    onClick={(e) => e.stopPropagation()}
                >
                    <SaveEventButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation />
                    <GoingButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation isPast={new Date(event.end).getTime() < Date.now()} />
                </div>
            )}
            <button
                type="button"
                aria-label={label}
                onClick={() => onClick(event)}
                onFocus={handleMouseEnter}
                onBlur={handleMouseLeave}
                className={`flex flex-1 text-left focus:outline-none focus:ring-2 focus:ring-action ${dateRail ? 'flex-row' : 'flex-col'}`}
            >
                {dateRail && (
                    <EventDateRail start={start} />
                )}
                <div className={`flex min-w-0 flex-1 flex-col ${dateRail ? 'px-2.5 py-2.5' : ''}`}>
                    <h3 className={`min-w-0 truncate text-sm font-semibold leading-snug text-ink group-hover:text-action ${compact ? '' : 'pr-16'}`} title={event.title}>
                        {isNew && (
                            <span
                                // eslint-disable-next-line no-restricted-syntax -- small status dot (new event indicator) — allowed exception per frontend rules
                                className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-action align-middle"
                                aria-label="New"
                                data-testid={newDotTestId}
                            />
                        )}
                        {title}
                    </h3>
                    {isTrending && (
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
                    {!dateRail && (
                        <div className="mt-1 flex items-center gap-3">
                            <span className="truncate text-xs font-medium text-ink-soft">{startLabel}</span>
                            {extraBadge}
                        </div>
                    )}
                    {location && (
                        <p
                            className="mt-1 truncate text-[11px] text-ink-soft"
                            title={event.location ?? undefined}
                            data-testid="rail-card-location"
                        >
                            {location}
                        </p>
                    )}
                    {(dateRail || showExtras) && (
                        <div className="mt-1 flex min-w-0 items-center gap-3" data-testid="rail-card-attendees">
                            {dateRail && extraBadge}
                            <AttendeeAvatarStack
                                eventId={event.event_id}
                                size="md"
                                friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                                hideIfOnlyCurrentUser={hideIfOnlyCurrentUser}
                            />
                        </div>
                    )}
                    {showExtras && event.tags && event.tags.length > 0 && (
                        <div className="mt-1.5">
                            <TagBadges
                                tags={event.tags}
                                maxVisible={maxTags ?? tagsPerCard}
                                forceBadge={forceTagBadge}
                                forceColored={forceTagColored}
                                singleLine={tagSingleLine}
                                priorityGroups={tagPriorityGroups}
                            />
                        </div>
                    )}
                </div>
            </button>
        </div>
    );
}
