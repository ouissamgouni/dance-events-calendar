import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent } from '../types';
import RailEventCard from './RailEventCard';
import { isTrendingScore } from '../utils/trending';

type ForYouLens = 'you-might-like' | 'friends' | 'new';

export interface ForYouLensState {
    events: CalendarEvent[];
    hasMore: boolean;
    loading: boolean;
    onLoadMore: () => void;
}

interface ForYouRailProps {
    /** "You might like": preference-matching upcoming events near the
     * viewer's saved area, sorted by popularity. */
    youMightLike: ForYouLensState;
    /** "Friends going": upcoming events friends are attending, sorted by
     * total commitment. */
    friendsGoing: ForYouLensState;
    /** "New": the unseen subset of "You might like" — shares the same
     * paginated fetch. */
    newEvents: ForYouLensState;
    onEventClick: (event: CalendarEvent) => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    /** Trending decoration gating — matches EventListPanel's PopularityBadge. */
    trendingEnabled: boolean;
    popularityThreshold: number;
    trendingTopN: number;
    trendingTopPercent: number;
    /** Unseen tracking — cards for events in this set get the blue-dot
     * "New" indicator, matching EventListPanel. */
    newEventIds?: Set<string>;
    unseenStateEnabled?: boolean;
    followingBadgeEnabled?: boolean;
    className?: string;
}

const DISPLAY_CAP = 5;

const LENS_ORDER: ForYouLens[] = ['you-might-like', 'friends', 'new'];

const LENS_LABELS: Record<ForYouLens, string> = {
    'you-might-like': 'You might like',
    friends: 'Friends going',
    new: 'New',
};

export default function ForYouRail({
    youMightLike,
    friendsGoing,
    newEvents,
    onEventClick,
    hoveredEventId,
    onEventHover,
    trendingEnabled,
    popularityThreshold,
    trendingTopN,
    trendingTopPercent,
    newEventIds,
    unseenStateEnabled = false,
    followingBadgeEnabled = false,
    className = '',
}: ForYouRailProps) {
    // Rails are expanded by default on both mobile and desktop; the
    // header caret still lets the viewer collapse them per session.
    const [collapsed, setCollapsed] = useState(false);

    const lensState = useMemo<Record<ForYouLens, ForYouLensState>>(
        () => ({ 'you-might-like': youMightLike, friends: friendsGoing, new: newEvents }),
        [youMightLike, friendsGoing, newEvents],
    );

    const availableLenses = useMemo(
        () => LENS_ORDER.filter((lens) => lensState[lens].events.length > 0),
        [lensState],
    );

    const [activeLens, setActiveLens] = useState<ForYouLens>('you-might-like');
    const [displayCap, setDisplayCap] = useState(DISPLAY_CAP);
    // Ref on the horizontal scroll container so we can reset scrollLeft
    // when the viewer switches lens — otherwise the previous lens's
    // scroll offset persists and the first card of the new lens can be
    // partially off-screen.
    const scrollerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (availableLenses.length === 0) return;
        if (!availableLenses.includes(activeLens)) {
            setActiveLens(availableLenses[0]);
        }
    }, [availableLenses, activeLens]);

    // Reset the client-side cap AND scroll offset whenever the viewer
    // switches lens — a fresh lens should start at the same "top 5"
    // density with the first card in view.
    useEffect(() => {
        setDisplayCap(DISPLAY_CAP);
        if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
    }, [activeLens]);

    // Cold-start guard: brand-new user with no matching data across any
    // lens sees no rail at all, rather than an empty shell.
    if (availableLenses.length === 0) return null;

    const active = lensState[activeLens];
    const lensEvents = active.events;
    const visibleEvents = lensEvents.slice(0, displayCap);
    const hasLocalMore = lensEvents.length > visibleEvents.length;
    const showMoreTile = hasLocalMore || active.hasMore;

    const handleMoreClick = () => {
        if (hasLocalMore) {
            setDisplayCap((cap) => cap + DISPLAY_CAP);
            return;
        }
        active.onLoadMore();
    };

    // Trending decoration is scoped to the CURRENT lens's visible set so
    // the top-K threshold reflects "trending within this list", matching
    // how PopularityBadge behaves in EventListPanel.
    const allScoresForLens = visibleEvents.map((event) => event.popularity_score ?? 0);

    return (
        <section className={`border border-blue-100 bg-white shadow-sm ${className}`} data-testid="for-you-rail">
            <div className="flex w-full items-center gap-2 border-b border-blue-50 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 hover:text-blue-900 focus:outline-none"
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? 'Expand For you' : 'Collapse For you'}
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <span aria-hidden="true" className="text-sm leading-none">💡</span>
                    For you
                </button>
                {!collapsed && availableLenses.length > 1 && (
                    <div
                        className="flex min-w-0 items-center gap-1 overflow-x-auto"
                        role="tablist"
                        aria-label="For you lens"
                    >
                        {availableLenses.map((lens) => {
                            const isActive = activeLens === lens;
                            return (
                                <button
                                    key={lens}
                                    type="button"
                                    role="tab"
                                    aria-selected={isActive}
                                    data-testid={`for-you-lens-tab-${lens}`}
                                    onClick={() => setActiveLens(lens)}
                                    className={`shrink-0 px-1.5 py-px text-[11px] font-medium transition border ${isActive
                                        ? 'bg-white border-blue-300 text-blue-700 shadow-sm'
                                        : 'bg-blue-50 border-blue-100 text-blue-600 hover:bg-white hover:border-blue-300'}`}
                                >
                                    {LENS_LABELS[lens]}
                                </button>
                            );
                        })}
                    </div>
                )}
                <button
                    type="button"
                    className="ml-auto shrink-0 text-xs text-slate-500 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-hidden="true"
                    tabIndex={-1}
                >
                    {collapsed ? '+' : '-'}
                </button>
            </div>
            {!collapsed && (
                <div ref={scrollerRef} className="flex gap-2 overflow-x-auto px-2 py-2" aria-label={`${LENS_LABELS[activeLens]} events`}>
                    {visibleEvents.map((event) => {
                        const isNew = !!unseenStateEnabled && !!newEventIds?.has(event.event_id);
                        const isTrending = trendingEnabled
                            && isTrendingScore(event.popularity_score ?? 0, allScoresForLens, popularityThreshold, trendingTopN, trendingTopPercent);
                        return (
                            <RailEventCard
                                key={event.event_id}
                                event={event}
                                onClick={onEventClick}
                                onHover={onEventHover}
                                highlighted={hoveredEventId === event.event_id}
                                isNew={isNew}
                                isTrending={isTrending}
                                followingBadgeEnabled={followingBadgeEnabled}
                                contextLabel={`${LENS_LABELS[activeLens].toLowerCase()} event`}
                                actionsTestId="for-you-card-actions"
                                newDotTestId="for-you-new-dot"
                            />
                        );
                    })}
                    {showMoreTile && (
                        <button
                            type="button"
                            onClick={handleMoreClick}
                            disabled={active.loading && !hasLocalMore}
                            data-testid="for-you-load-more"
                            className="flex w-[110px] shrink-0 items-center justify-center self-stretch border border-dashed border-blue-300 bg-blue-50/40 text-center text-[11px] font-semibold text-blue-600 shadow-sm transition hover:border-blue-500 hover:bg-blue-50 hover:text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-wait disabled:opacity-60"
                            aria-label={`Show more ${LENS_LABELS[activeLens].toLowerCase()} events`}
                        >
                            {active.loading && !hasLocalMore ? 'Loading…' : '+ more'}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
