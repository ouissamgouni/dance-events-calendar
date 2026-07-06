import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CalendarEvent } from '../types';
import { fetchEventsByIds } from '../api';
import { useAuth } from '../context/AuthContext';
import { usePreferences } from '../context/PreferencesContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useForYouLens } from '../hooks/useForYouLens';
import { useSeenEvents } from '../hooks/useSeenEvents';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import { trackView } from '../utils/tracking';
import { isTrendingScore } from '../utils/trending';
import ExplorerNav from '../components/ExplorerNav';
import YourNextEventsRail from '../components/YourNextEventsRail';
import RailEventCard from '../components/RailEventCard';

const DISPLAY_CAP = 5;

function toApiDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

interface LensTrailProps {
    title: string;
    events: CalendarEvent[];
    hasMore: boolean;
    loading: boolean;
    onLoadMore: () => void;
    onEventClick: (event: CalendarEvent) => void;
    hoveredEventId: string | null;
    onEventHover: (eventId: string | null) => void;
    trendingEnabled: boolean;
    popularityThreshold: number;
    trendingTopN: number;
    trendingTopPercent: number;
    newEventIds: Set<string>;
    unseenStateEnabled: boolean;
    followingBadgeEnabled: boolean;
    emptyLabel?: string;
    contextLabel: string;
    testId: string;
}

function LensTrail(props: LensTrailProps) {
    const {
        title, events, hasMore, loading, onLoadMore, onEventClick,
        hoveredEventId, onEventHover, trendingEnabled, popularityThreshold,
        trendingTopN, trendingTopPercent, newEventIds, unseenStateEnabled,
        followingBadgeEnabled, emptyLabel, contextLabel, testId,
    } = props;
    const [displayCap, setDisplayCap] = useState(DISPLAY_CAP);
    const visibleEvents = events.slice(0, displayCap);
    const hasLocalMore = events.length > visibleEvents.length;
    const showMoreTile = hasLocalMore || hasMore;
    const allScores = visibleEvents.map((event) => event.popularity_score ?? 0);

    const handleMore = () => {
        if (hasLocalMore) {
            setDisplayCap((cap) => cap + DISPLAY_CAP);
            return;
        }
        onLoadMore();
    };

    return (
        <section data-testid={testId}>
            <div className="flex w-full items-center justify-between border-b border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700">
                <span>{title}</span>
            </div>
            {events.length === 0 ? (
                <p className="px-2.5 py-3 text-xs text-slate-500">
                    {emptyLabel ?? 'Nothing here yet.'}
                </p>
            ) : (
                <div className="flex gap-2 overflow-x-auto px-2 py-2" aria-label={title}>
                    {visibleEvents.map((event) => {
                        const isNew = unseenStateEnabled && newEventIds.has(event.event_id);
                        const isTrending = trendingEnabled
                            && isTrendingScore(event.popularity_score ?? 0, allScores, popularityThreshold, trendingTopN, trendingTopPercent);
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
                                contextLabel={contextLabel}
                            />
                        );
                    })}
                    {showMoreTile && (
                        <button
                            type="button"
                            onClick={handleMore}
                            disabled={loading && !hasLocalMore}
                            className="flex w-[110px] shrink-0 items-center justify-center self-stretch bg-slate-50 text-center text-[11px] font-semibold text-blue-600 transition hover:bg-slate-100 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-wait disabled:opacity-60"
                        >
                            {loading && !hasLocalMore ? 'Loading…' : '+ more'}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}

/**
 * "For you" surface: personalised event shortcuts for a signed-in viewer.
 * Renders four horizontal trails — Your next events, You might like,
 * Friends going, New — each independently paginated / scoped so a slow
 * lens never blocks the others.
 */
export default function ForYouPage() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { prefs } = usePreferences();
    const { savedEventIds } = useSavedEvents();
    const { attendingEventIds, attendingCount } = useAttendingEvents();
    const {
        unseenStateEnabled,
        trendingEnabled,
        showPopularity,
        popularityThreshold,
        trendingTopN,
        trendingTopPercent,
        followingBadgeEnabled,
    } = useFeatureFlags();
    const { savedCount } = useSavedEvents();

    const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
    const onEventHover = useCallback((id: string | null) => setHoveredEventId(id), []);

    const forYouArea = useMemo(() => {
        const src = prefs.area ?? DEFAULT_AREA_BBOX;
        return {
            min_lat: src.min_lat,
            min_lng: src.min_lng,
            max_lat: src.max_lat,
            max_lng: src.max_lng,
        };
    }, [prefs.area]);
    const forYouStartDate = useMemo(() => toApiDate(new Date()), []);
    const forYouResetKey = useMemo(
        () => JSON.stringify({ a: forYouArea, s: forYouStartDate }),
        [forYouArea, forYouStartDate],
    );

    const youMightLikeLens = useForYouLens({
        enabled: !!user,
        fetchArgs: { startDate: forYouStartDate, profiles: 'me' },
        resetKey: forYouResetKey,
    });
    const friendsLens = useForYouLens({
        enabled: !!user,
        fetchArgs: {
            startDate: forYouStartDate,
            area: forYouArea,
            interestSource: 'friends',
            interestKind: 'any',
        },
        resetKey: forYouResetKey,
    });

    // Client-side "not yet ended" guard — the backend `startDate` filter
    // lets through events whose start is still today but whose end has
    // already passed (e.g. a Friday social that ended at 1am). `Date.now()`
    // is snapshotted inside each memo so we stay pure at render time. Save
    // and RSVP no longer remove the event from the trail — the buttons
    // still update the counts/visibility and their internal toast fires;
    // the card just stays put so the viewer keeps their scroll position.
    const youMightLikeEvents = useMemo(() => {
        // eslint-disable-next-line react-hooks/purity -- render-time clock snapshot for past-event filter
        const now = Date.now();
        return youMightLikeLens.events
            .filter((event) => new Date(event.end).getTime() >= now)
            .sort((a, b) => (b.popularity_score ?? 0) - (a.popularity_score ?? 0));
    }, [youMightLikeLens.events]);
    const friendsGoingEvents = useMemo(() => {
        // eslint-disable-next-line react-hooks/purity -- render-time clock snapshot for past-event filter
        const now = Date.now();
        return friendsLens.events
            .filter((event) => new Date(event.end).getTime() >= now)
            .sort(
                (a, b) => (b.going_count ?? 0) + (b.saved_count ?? 0) - ((a.going_count ?? 0) + (a.saved_count ?? 0)),
            );
    }, [friendsLens.events]);

    const seenScopeIds = useMemo(
        () => [
            ...youMightLikeLens.events.map((event) => event.event_id),
            ...friendsLens.events.map((event) => event.event_id),
        ],
        [youMightLikeLens.events, friendsLens.events],
    );
    const { newEventIds, markSeen } = useSeenEvents(seenScopeIds);
    const newEvents = useMemo(
        () => youMightLikeEvents.filter((event) => newEventIds.has(event.event_id)),
        [youMightLikeEvents, newEventIds],
    );

    const yourNextEventIds = useMemo(
        () => [...new Set([...savedEventIds, ...attendingEventIds])],
        [savedEventIds, attendingEventIds],
    );
    const [rawYourNextEvents, setRawYourNextEvents] = useState<CalendarEvent[]>([]);
    useEffect(() => {
        if (!user || yourNextEventIds.length === 0) return;
        let cancelled = false;
        fetchEventsByIds(yourNextEventIds)
            .then((evts) => {
                if (cancelled) return;
                const now = Date.now();
                setRawYourNextEvents(
                    evts
                        .filter((e) => new Date(e.end).getTime() >= now)
                        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
                );
            })
            .catch(() => {
                /* keep previous list on fetch error */
            });
        return () => {
            cancelled = true;
        };
    }, [user, yourNextEventIds]);
    // Derive the visible list from the current id set so it collapses instantly
    // when the user unsaves/removes going, without a stale-state reset in the effect.
    const yourNextEvents = useMemo(() => {
        if (!user || yourNextEventIds.length === 0) return [];
        const ids = new Set(yourNextEventIds);
        return rawYourNextEvents.filter((e) => ids.has(e.event_id));
    }, [user, yourNextEventIds, rawYourNextEvents]);

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        markSeen(evt.event_id);
        trackView(evt.event_id, 'for-you');
        navigate(`/event/${evt.event_id}?src=for-you`);
    }, [markSeen, navigate]);

    const handleSearchEventClick = useCallback((eventId: string) => {
        markSeen(eventId);
        navigate(`/event/${eventId}?src=for-you-search`);
    }, [markSeen, navigate]);

    const trendingDecoration = trendingEnabled && showPopularity;

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-2 sm:py-4">
                <div className="mb-3 sm:mb-4 flex flex-wrap items-center gap-2">
                    <ExplorerNav active="for-you" onSelectSearchEvent={handleSearchEventClick} />
                </div>
                {!user ? (
                    <div className="bg-blue-50 border border-blue-100 p-4 text-sm text-slate-700">
                        <p className="mb-2 font-medium text-slate-800">Personalised events for you</p>
                        <p className="mb-3 text-slate-600">Sign in to see events tailored to your saved area, dance styles and friends.</p>
                        <Link
                            to={`/login?next=${encodeURIComponent('/for-you')}`}
                            className="inline-flex items-center bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-300"
                        >
                            Sign in
                        </Link>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <YourNextEventsRail
                            events={yourNextEvents}
                            onEventClick={handleEventClick}
                            hoveredEventId={hoveredEventId}
                            onEventHover={onEventHover}
                            newEventIds={newEventIds}
                            unseenStateEnabled={unseenStateEnabled}
                            headerRight={(
                                <>
                                    <span>{savedCount} saved</span>
                                    <span className="text-slate-300"> · </span>
                                    <span>{attendingCount} going</span>
                                </>
                            )}
                        />
                        <LensTrail
                            title="You might like"
                            testId="for-you-you-might-like"
                            contextLabel="you might like event"
                            emptyLabel="Save a few dance styles in your profile to see recommendations here."
                            events={youMightLikeEvents}
                            hasMore={youMightLikeLens.hasMore}
                            loading={youMightLikeLens.loading}
                            onLoadMore={youMightLikeLens.loadMore}
                            onEventClick={handleEventClick}
                            hoveredEventId={hoveredEventId}
                            onEventHover={onEventHover}
                            trendingEnabled={trendingDecoration}
                            popularityThreshold={popularityThreshold}
                            trendingTopN={trendingTopN}
                            trendingTopPercent={trendingTopPercent}
                            newEventIds={newEventIds}
                            unseenStateEnabled={unseenStateEnabled}
                            followingBadgeEnabled={followingBadgeEnabled}
                        />
                        <LensTrail
                            title="Friends going"
                            testId="for-you-friends-going"
                            contextLabel="friends-going event"
                            emptyLabel="No friends are going to anything upcoming yet."
                            events={friendsGoingEvents}
                            hasMore={friendsLens.hasMore}
                            loading={friendsLens.loading}
                            onLoadMore={friendsLens.loadMore}
                            onEventClick={handleEventClick}
                            hoveredEventId={hoveredEventId}
                            onEventHover={onEventHover}
                            trendingEnabled={trendingDecoration}
                            popularityThreshold={popularityThreshold}
                            trendingTopN={trendingTopN}
                            trendingTopPercent={trendingTopPercent}
                            newEventIds={newEventIds}
                            unseenStateEnabled={unseenStateEnabled}
                            followingBadgeEnabled={followingBadgeEnabled}
                        />
                        <LensTrail
                            title="New"
                            testId="for-you-new"
                            contextLabel="new event"
                            emptyLabel="No new matches since your last visit."
                            events={newEvents}
                            hasMore={youMightLikeLens.hasMore}
                            loading={youMightLikeLens.loading}
                            onLoadMore={youMightLikeLens.loadMore}
                            onEventClick={handleEventClick}
                            hoveredEventId={hoveredEventId}
                            onEventHover={onEventHover}
                            trendingEnabled={trendingDecoration}
                            popularityThreshold={popularityThreshold}
                            trendingTopN={trendingTopN}
                            trendingTopPercent={trendingTopPercent}
                            newEventIds={newEventIds}
                            unseenStateEnabled={unseenStateEnabled}
                            followingBadgeEnabled={followingBadgeEnabled}
                        />
                    </div>
                )}
            </main>
        </div>
    );
}
