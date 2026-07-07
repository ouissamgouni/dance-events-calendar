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
}: RailEventCardProps) {
    const { tagsPerCard } = useFeatureFlags();
    const startLabel = formatRailDate(event.start);
    const label = `Open ${event.title}, ${contextLabel} on ${startLabel}`;
    const title = truncateText(event.title);
    const location = shortLocation(event.location);
    const compact = variant === 'compact';
    const showExtras = !compact || compactShowExtras;
    const cardSize = compact ? 'w-[196px]' : 'w-[212px] min-h-[116px]';

    const handleMouseEnter = useCallback(() => onHover?.(event.event_id), [onHover, event.event_id]);
    const handleMouseLeave = useCallback(() => onHover?.(null), [onHover]);

    return (
        <div
            // eslint-disable-next-line no-restricted-syntax -- rounded event cards per explicit design request (For you + Trending trails)
            className={`group relative flex ${cardSize} shrink-0 flex-col rounded-md border border-slate-200 bg-white px-2 py-2 text-left transition hover:bg-slate-50 ${highlighted ? 'ring-1 ring-blue-200' : ''}`}
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
                    <GoingButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation />
                </div>
            )}
            <button
                type="button"
                aria-label={label}
                onClick={() => onClick(event)}
                onFocus={handleMouseEnter}
                onBlur={handleMouseLeave}
                className="flex flex-1 flex-col text-left focus:outline-none focus:ring-2 focus:ring-blue-300"
            >
                <h3 className={`min-w-0 truncate text-xs font-semibold leading-snug text-slate-900 group-hover:text-blue-700 ${compact ? '' : 'pr-16'}`} title={event.title}>
                    {isNew && (
                        <span
                            // eslint-disable-next-line no-restricted-syntax -- small status dot (new event indicator) — allowed exception per frontend rules
                            className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
                            aria-label="New"
                            data-testid={newDotTestId}
                        />
                    )}
                    {title}
                </h3>
                {isTrending && (
                    <div className="mt-0.5">
                        <span
                            className="inline-flex items-center bg-orange-50 px-1.5 py-px text-[10px] font-medium text-orange-400"
                            data-testid="trending-badge"
                            title="Trending"
                        >
                            Trending
                        </span>
                    </div>
                )}
                <div className="mt-0.5 flex items-center gap-3">
                    <span className="truncate text-[11px] font-medium text-slate-600">{startLabel}</span>
                    {extraBadge}
                    <AttendeeAvatarStack
                        eventId={event.event_id}
                        size="sm"
                        friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                    />
                </div>
                {location && (
                    <p className="mt-0.5 truncate text-[10px] text-slate-500" title={event.location ?? undefined}>
                        {location}
                    </p>
                )}
                {showExtras && event.tags && event.tags.length > 0 && (
                    <div className="mt-1">
                        <TagBadges tags={event.tags} maxVisible={tagsPerCard} />
                    </div>
                )}
            </button>
        </div>
    );
}
