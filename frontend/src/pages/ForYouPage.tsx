import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CalendarEvent, PendingReview } from '../types';
import { fetchEventsByIds, fetchMyPendingReviews } from '../api';
import { useAuth } from '../context/AuthContext';
import { usePreferences } from '../context/PreferencesContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useForYouLens } from '../hooks/useForYouLens';
import { useSeenEvents } from '../hooks/useSeenEvents';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import { firstNameOf } from '../utils/displayName';
import { trackView } from '../utils/tracking';
import { isTrendingScore } from '../utils/trending';
import YourNextEventsRail from '../components/YourNextEventsRail';
import RailEventCard from '../components/RailEventCard';
import FriendsAreGoingCard from '../components/FriendsAreGoingCard';
import ShareExperienceCard from '../components/ShareExperienceCard';
import PeopleYouMayKnowCard from '../components/PeopleYouMayKnowCard';
import SectionHeading, { type SectionHeadingAction } from '../components/SectionHeading';
import ScrollDotsIndicator from '../components/ScrollDots';
import { useScrollDots } from '../hooks/useScrollDots';

const DISPLAY_CAP = 5;

export function timeOfDayGreeting(hour: number): string {
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
}

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
    emptyContent?: ReactNode;
    contextLabel: string;
    testId: string;
    headerAction?: SectionHeadingAction;
    cardVariant?: 'default' | 'friends-going';
}

export function LensTrail(props: LensTrailProps) {
    const {
        title, events, hasMore, loading, onLoadMore, onEventClick,
        hoveredEventId, onEventHover, trendingEnabled, popularityThreshold,
        trendingTopN, trendingTopPercent, newEventIds, unseenStateEnabled,
        followingBadgeEnabled, emptyContent, contextLabel, testId, headerAction,
        cardVariant = 'default',
    } = props;
    const friendsGoing = cardVariant === 'friends-going';
    const [displayCap, setDisplayCap] = useState(DISPLAY_CAP);
    const visibleEvents = events.slice(0, displayCap);
    const hasLocalMore = events.length > visibleEvents.length;
    const showMoreTile = hasLocalMore || hasMore;
    const allScores = visibleEvents.map((event) => event.popularity_score ?? 0);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(scrollerRef, [displayCap, events.length]);

    const handleMore = () => {
        if (hasLocalMore) {
            setDisplayCap((cap) => cap + DISPLAY_CAP);
            return;
        }
        onLoadMore();
    };

    return (
        <section data-testid={testId}>
            <SectionHeading title={title} action={headerAction} />
            {events.length === 0 ? (
                <div className="px-2.5 py-3 text-xs text-ink-soft">
                    {emptyContent ?? 'Nothing here yet.'}
                </div>
            ) : (
                <div
                    ref={scrollerRef}
                    className={`flex overflow-x-auto scrollbar-hide py-2 ${friendsGoing ? 'snap-x snap-mandatory gap-3' : 'gap-2'}`}
                    aria-label={title}
                >
                    {visibleEvents.map((event) => {
                        if (friendsGoing) {
                            return (
                                <FriendsAreGoingCard
                                    key={event.event_id}
                                    event={event}
                                    onClick={onEventClick}
                                />
                            );
                        }
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
                            className="flex w-[110px] shrink-0 items-center justify-center self-stretch bg-canvas text-center text-[11px] font-semibold text-action transition hover:bg-canvas hover:text-action focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-wait disabled:opacity-60"
                        >
                            {loading && !hasLocalMore ? 'Loading…' : '+ more'}
                        </button>
                    )}
                </div>
            )}
            {events.length > 0 && (
                <ScrollDotsIndicator
                    count={dotCount}
                    activeIndex={activeIndex}
                    onSelect={scrollToIndex}
                    label={`${title} scroll position`}
                />
            )}
        </section>
    );
}

/**
 * "For you" surface: personalised event shortcuts for a signed-in viewer.
 * Renders five horizontal trails — Your next events, You might like,
 * Friends are going, Build your tribe, New — each independently
 * paginated / scoped so a slow lens never blocks the others.
 */
export default function ForYouPage() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { prefs } = usePreferences();
    const { attendingEventIds, loading: attendingEventsLoading } = useAttendingEvents();
    const {
        unseenStateEnabled,
        trendingEnabled,
        showPopularity,
        popularityThreshold,
        trendingTopN,
        trendingTopPercent,
        followingBadgeEnabled,
    } = useFeatureFlags();

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
    const friendsGoingLens = useForYouLens({
        enabled: !!user,
        fetchArgs: {
            startDate: forYouStartDate,
            area: forYouArea,
            interestSource: 'friends',
            interestKind: 'going',
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
        return friendsGoingLens.events
            .filter((event) => new Date(event.end).getTime() >= now)
            .sort(
                (a, b) => (b.friends_going_count ?? 0) - (a.friends_going_count ?? 0)
                    || new Date(a.start).getTime() - new Date(b.start).getTime(),
            );
    }, [friendsGoingLens.events]);

    const seenScopeIds = useMemo(
        () => [
            ...youMightLikeLens.events.map((event) => event.event_id),
            ...friendsGoingLens.events.map((event) => event.event_id),
        ],
        [youMightLikeLens.events, friendsGoingLens.events],
    );
    const { newEventIds, markSeen } = useSeenEvents(seenScopeIds);
    const newEvents = useMemo(
        () => youMightLikeEvents.filter((event) => newEventIds.has(event.event_id)),
        [youMightLikeEvents, newEventIds],
    );

    const [rawYourNextEvents, setRawYourNextEvents] = useState<CalendarEvent[]>([]);
    const [yourNextEventsLoading, setYourNextEventsLoading] = useState(true);
    useEffect(() => {
        if (!user) {
            setRawYourNextEvents([]);
            setYourNextEventsLoading(false);
            return;
        }
        if (attendingEventsLoading) {
            setYourNextEventsLoading(true);
            return;
        }
        if (attendingEventIds.length === 0) {
            setRawYourNextEvents([]);
            setYourNextEventsLoading(false);
            return;
        }
        let cancelled = false;
        setYourNextEventsLoading(true);
        fetchEventsByIds(attendingEventIds)
            .then((evts) => {
                if (cancelled) return;
                const now = Date.now();
                setRawYourNextEvents(
                    evts
                        .filter((e) => new Date(e.end).getTime() >= now)
                        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
                );
                setYourNextEventsLoading(false);
            })
            .catch(() => {
                if (!cancelled) setYourNextEventsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [user, attendingEventIds, attendingEventsLoading]);
    // Derive from the live Going IDs so removing an RSVP updates immediately.
    const yourNextEvents = useMemo(() => {
        if (!user || attendingEventIds.length === 0) return [];
        const ids = new Set(attendingEventIds);
        return rawYourNextEvents
            .filter((e) => ids.has(e.event_id))
            .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    }, [user, attendingEventIds, rawYourNextEvents]);

    // "Share your experience": past events the viewer attended but hasn't
    // reviewed yet (server applies the admin-configurable recency window).
    const [pendingReviews, setPendingReviews] = useState<PendingReview[]>([]);
    useEffect(() => {
        if (!user) return;
        let cancelled = false;
        fetchMyPendingReviews()
            .then((rows) => {
                if (!cancelled) setPendingReviews(rows);
            })
            .catch(() => {
                /* keep previous list on fetch error */
            });
        return () => {
            cancelled = true;
        };
    }, [user]);
    const handleReviewed = useCallback((eventId: string) => {
        setPendingReviews((prev) => prev.filter((r) => r.event_id !== eventId));
    }, []);

    const shareScrollerRef = useRef<HTMLDivElement>(null);
    const shareDots = useScrollDots(shareScrollerRef, [pendingReviews.length]);

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        markSeen(evt.event_id);
        trackView(evt.event_id, 'for-you');
        navigate(`/event/${evt.event_id}?src=for-you`);
    }, [markSeen, navigate]);

    const trendingDecoration = trendingEnabled && showPopularity;
    const firstName = firstNameOf(user?.name, user?.handle);
    const greeting = timeOfDayGreeting(new Date().getHours());

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-4 sm:py-6">
                <header className="mb-4">
                    <h1 className="text-2xl font-bold text-ink">
                        {greeting}{firstName ? `, ${firstName}` : ''} 👋
                    </h1>
                    <p className="mt-1 text-[12px] text-ink-soft">Your picks for today.</p>
                </header>
                {!user ? (
                    <div className="bg-blue-50 border border-blue-100 p-4 text-sm text-ink">
                        <p className="mb-2 font-medium text-ink">Personalised events for you</p>
                        <p className="mb-3 text-ink-soft">Sign in to see events tailored to your saved area, dance styles and friends.</p>
                        <Link
                            to={`/login?next=${encodeURIComponent('/for-you')}`}
                            className="inline-flex items-center bg-action px-3 py-1.5 text-xs font-semibold text-white hover:bg-action focus:outline-none focus:ring-2 focus:ring-blue-300"
                        >
                            Sign in
                        </Link>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <YourNextEventsRail
                            events={yourNextEvents}
                            onEventClick={handleEventClick}
                            loading={attendingEventsLoading || yourNextEventsLoading}
                        />
                        <LensTrail
                            title="You might like"
                            testId="for-you-you-might-like"
                            contextLabel="you might like event"
                            emptyContent={(
                                <>
                                    Save a few dance styles in your profile to see recommendations here.{' '}
                                    <Link to="/account#preferences" className="font-semibold text-action hover:text-action">
                                        Update your preferences
                                    </Link>
                                </>
                            )}
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
                            title="Friends are going"
                            testId="for-you-following-friends-going"
                            contextLabel="friends going event"
                            cardVariant="friends-going"
                            headerAction={{
                                label: 'See all',
                                to: '/tribe/calendars?interest_source=friends&interest_kind=going',
                            }}
                            emptyContent={(
                                (user?.following_count ?? 0) === 0 ? (
                                    <>
                                        <p className="mb-2">You&apos;re not following anyone yet.</p>
                                        <Link
                                            to="/tribe/discover"
                                            className="inline-flex items-center bg-action px-3 py-1.5 text-xs font-semibold text-white hover:bg-action focus:outline-none focus:ring-2 focus:ring-blue-300"
                                        >
                                            Build your tribe
                                        </Link>
                                    </>
                                ) : 'No friends are going to anything upcoming yet.'
                            )}
                            events={friendsGoingEvents}
                            hasMore={friendsGoingLens.hasMore}
                            loading={friendsGoingLens.loading}
                            onLoadMore={friendsGoingLens.loadMore}
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
                        {pendingReviews.length > 0 && (
                            <section data-testid="for-you-share-your-experience">
                                <SectionHeading title="Share your experience" />
                                <div ref={shareScrollerRef} className="flex gap-2 overflow-x-auto scrollbar-hide px-2 py-2" aria-label="Share your experience">
                                    {pendingReviews.map((review) => (
                                        <ShareExperienceCard
                                            key={review.event_id}
                                            review={review}
                                            onReviewed={handleReviewed}
                                        />
                                    ))}
                                </div>
                                <ScrollDotsIndicator
                                    count={shareDots.dotCount}
                                    activeIndex={shareDots.activeIndex}
                                    onSelect={shareDots.scrollToIndex}
                                    label="Share your experience scroll position"
                                />
                            </section>
                        )}
                        <LensTrail
                            title="New"
                            testId="for-you-new"
                            contextLabel="new event"
                            emptyContent="No new matches since your last visit."
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
                        <PeopleYouMayKnowCard variant="trail" />
                    </div>
                )}
            </main>
        </div>
    );
}
