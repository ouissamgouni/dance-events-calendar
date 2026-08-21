import { useCallback, type ReactNode } from 'react';
import type { CalendarEvent } from '../types';
import TagBadges from './TagBadges';
import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';
import AttendeeAvatarStack from './AttendeeAvatarStack';
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
    /** Keeps tag badges on a single line, clipping overflow to a "+x". */
    tagSingleLine?: boolean;
    /** Group slugs whose tags sort first in the badge row. */
    tagPriorityGroups?: string[];
    /** Forces colored tag badges regardless of the feature flag. */
    forceTagColored?: boolean;
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
    tagSingleLine = false,
    tagPriorityGroups,
    forceTagColored = false,
}: RailEventCardProps) {
    const { tagsPerCard } = useFeatureFlags();
    const startLabel = formatRailDate(event.start);
    const label = `Open ${event.title}, ${contextLabel} on ${startLabel}`;
    const title = truncateText(event.title);
    const location = shortLocation(event.location);
    const compact = variant === 'compact';
    const showExtras = !compact || compactShowExtras;
    const cardSize = widthClass ?? (compact ? 'w-[208px]' : 'w-[224px]');
    const surface = accent
        ? 'border-blue-200 bg-blue-50 hover:bg-blue-100'
        : 'border-card-line bg-surface hover:bg-canvas';

    const handleMouseEnter = useCallback(() => onHover?.(event.event_id), [onHover, event.event_id]);
    const handleMouseLeave = useCallback(() => onHover?.(null), [onHover]);

    return (
        <div
            className={`group relative flex ${cardSize} shrink-0 flex-col rounded-card border ${surface} px-2.5 py-2.5 text-left transition ${highlighted ? 'ring-1 ring-action' : ''}`}
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
                className="flex flex-1 flex-col text-left focus:outline-none focus:ring-2 focus:ring-action"
            >
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
                <div className="mt-1 flex items-center gap-3">
                    <span className="truncate text-xs font-medium text-ink-soft">{startLabel}</span>
                    {extraBadge}
                    <AttendeeAvatarStack
                        eventId={event.event_id}
                        size="sm"
                        friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                    />
                </div>
                {location && (
                    <p className="mt-1 truncate text-[11px] text-ink-soft" title={event.location ?? undefined}>
                        {location}
                    </p>
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
            </button>
        </div>
    );
}
