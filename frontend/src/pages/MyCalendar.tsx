import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
    fetchEventsByIds,
    exportIcs,
    exportXlsx,
    createShareToken,
    getCalendarFeedUrl,
    fetchSubscribedEvents,
    fetchMySubscriptions,
    fetchMyFriends,
    type SubscribedUser,
    type SubscribedEventItem,
} from '../api';
import { getDeviceId } from '../utils/deviceId';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useAuth } from '../context/AuthContext';
import { trackExportAction, trackView } from '../utils/tracking';
import EventListPanel from '../components/EventListPanel';
import EventMap from '../components/EventMap';
import type { MapBounds } from '../components/EventMap';
import EventModal from '../components/EventModal';
import MySubscribersBadge from '../components/MySubscribersBadge';
import { InterestFilterChips, type InterestFilterChange } from '../components/InterestFilter';
import { firstNameOf, formatNameList } from '../utils/displayName';
import type { CalendarEvent } from '../types';
import MyEventsExperience from './MyEventsExperience';

type Filter = 'all' | 'saved' | 'going';
type InterestSource = 'follows' | 'friends' | null;
type InterestKind = 'any' | 'going' | 'saved';
type InterestMatch = 'any' | 'all';

export function initialEventFilter(search: string): Filter {
    const value = new URLSearchParams(search).get('filter');
    return value === 'saved' || value === 'going' ? value : 'all';
}

export function initialInterestSource(search: string): InterestSource {
    const value = new URLSearchParams(search).get('interest_source');
    return value === 'follows' || value === 'friends' ? value : null;
}

export function initialInterestKind(search: string): InterestKind {
    const value = new URLSearchParams(search).get('interest_kind');
    return value === 'any' || value === 'going' || value === 'saved' ? value : 'going';
}

/** Relative countdown — "now", "in 1 day", "in 3 days", "in a week", "in 2 weeks". */
function formatRelativeWhen(startIso: string): string {
    const diffDays = Math.round((new Date(startIso).getTime() - Date.now()) / 86_400_000);
    if (diffDays <= 0) return 'now';
    if (diffDays === 1) return 'in 1 day';
    if (diffDays < 7) return `in ${diffDays} days`;
    if (diffDays < 14) return 'in a week';
    return `in ${Math.round(diffDays / 7)} weeks`;
}

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function LegacyCalendar() {
    const location = useLocation();
    const navigate = useNavigate();
    const { savedEventIds, savedCount, isSaved } = useSavedEvents();
    const { attendingEventIds, attendingCount, isAttending } = useAttendingEvents();
    const { showPrices, showPopularity, popularityThreshold, networkGoingSnapshotEnabled } = useFeatureFlags();
    const { user, loading: authLoading } = useAuth();
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
    const [sortBy, setSortBy] = useState<'date' | 'popularity'>('date');
    const [exporting, setExporting] = useState('');
    const [shareStatus, setShareStatus] = useState<'idle' | 'loading' | 'copied'>('idle');
    const [exportMenuOpen, setExportMenuOpen] = useState(false);
    const exportMenuRef = useRef<HTMLDivElement | null>(null);
    const [exportScope, setExportScope] = useState<Filter>('all');
    const [subscribeOpen, setSubscribeOpen] = useState(false);
    const [feedUrl, setFeedUrl] = useState('');
    const [feedStatus, setFeedStatus] = useState<'idle' | 'loading' | 'copied'>('idle');
    const [activeFilter, setActiveFilter] = useState<Filter>(() => initialEventFilter(location.search));
    const [showPastEvents, setShowPastEvents] = useState(false);
    const [subsEvents, setSubsEvents] = useState<CalendarEvent[]>([]);
    const [subsLoading, setSubsLoading] = useState(false);
    const [subsCalendars, setSubsCalendars] = useState<SubscribedUser[]>([]);
    const [interestSource, setInterestSource] = useState<InterestSource>(() => initialInterestSource(location.search));
    const [interestKind, setInterestKind] = useState<InterestKind>(() => initialInterestKind(location.search));
    const [interestUserHandles, setInterestUserHandles] = useState<string[]>([]);
    const [interestMatch, setInterestMatch] = useState<InterestMatch>('any');
    const [friendHandles, setFriendHandles] = useState<string[]>([]);
    const [snapshotEvents, setSnapshotEvents] = useState<SubscribedEventItem[]>([]);
    const [signInNudgeDismissed, setSignInNudgeDismissed] = useState<boolean>(() => {
        if (typeof window === 'undefined') return false;
        return window.localStorage.getItem('myCalendar.signInNudge.dismissed') === '1';
    });
    const dismissSignInNudge = useCallback(() => {
        setSignInNudgeDismissed(true);
        try { window.localStorage.setItem('myCalendar.signInNudge.dismissed', '1'); } catch { /* ignore quota */ }
    }, []);

    const isSubscriptionsRoute = location.pathname === '/tribe/calendars';
    const activeView: 'mine' | 'subs' = isSubscriptionsRoute ? 'subs' : 'mine';

    const allEventIds = useMemo(
        () => [...new Set([...savedEventIds, ...attendingEventIds])],
        [savedEventIds, attendingEventIds],
    );

    const scopedEventIds = useMemo(() => {
        if (exportScope === 'saved') return savedEventIds;
        if (exportScope === 'going') return attendingEventIds;
        return allEventIds;
    }, [exportScope, savedEventIds, attendingEventIds, allEventIds]);

    const showFilterTabs = savedCount > 0 && attendingCount > 0;

    useEffect(() => {
        if (isSubscriptionsRoute && !authLoading && !user) {
            navigate(`/login?next=${encodeURIComponent('/tribe/calendars')}`, { replace: true });
        }
    }, [authLoading, isSubscriptionsRoute, navigate, user]);

    useEffect(() => {
        if (activeView !== 'mine') {
            setLoading(false);
            return;
        }
        if (allEventIds.length === 0) {
            setEvents([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        fetchEventsByIds(allEventIds)
            .then(setEvents)
            .catch(() => setEvents([]))
            .finally(() => setLoading(false));
    }, [activeView, allEventIds]);

    useEffect(() => {
        if (!user) {
            setSubsCalendars([]);
            setFriendHandles([]);
            return;
        }
        let cancelled = false;
        fetchMySubscriptions({ limit: 50 })
            .then((res) => {
                if (cancelled) return;
                setSubsCalendars(res.items);
            })
            .catch(() => { /* tolerate; empty-state copy just falls back */ });
        fetchMyFriends({ limit: 100 })
            .then((res) => {
                if (cancelled) return;
                setFriendHandles(res.items.map((f) => f.handle));
            })
            .catch(() => { /* tolerate; friends scope degrades to none */ });
        return () => { cancelled = true; };
    }, [user]);

    useEffect(() => {
        if (!isSubscriptionsRoute || !user) return;
        const kind: Filter = interestKind === 'any' ? 'all' : interestKind;
        // Map the explorer-style interest scope onto subscribed-event params:
        // explicit people win; otherwise "friends" scope narrows to mutuals.
        const fromHandles = interestUserHandles.length
            ? interestUserHandles
            : interestSource === 'friends'
                ? friendHandles
                : [];
        // "Friends" scope with no mutuals must show nothing rather than
        // falling back to every subscription.
        if (interestSource === 'friends' && !interestUserHandles.length && friendHandles.length === 0) {
            setSubsEvents([]);
            setSubsLoading(false);
            return;
        }
        let cancelled = false;
        setSubsLoading(true);
        fetchSubscribedEvents({ fromHandles, kind, match: interestUserHandles.length ? interestMatch : 'any', limit: 100 })
            .then((res) => {
                if (cancelled) return;
                setSubsEvents(res.items);
            })
            .catch(() => { if (!cancelled) setSubsEvents([]); })
            .finally(() => { if (!cancelled) setSubsLoading(false); });
        return () => { cancelled = true; };
    }, [isSubscriptionsRoute, user, interestSource, interestKind, interestUserHandles, interestMatch, friendHandles]);

    // "Your Network" snapshot: upcoming events people you follow are going
    // to, grouped by event, independent of the active filter above.
    useEffect(() => {
        if (!isSubscriptionsRoute || !user || !networkGoingSnapshotEnabled) {
            setSnapshotEvents([]);
            return;
        }
        let cancelled = false;
        fetchSubscribedEvents({ kind: 'going', limit: 100 })
            .then((res) => {
                if (cancelled) return;
                setSnapshotEvents(res.items);
            })
            .catch(() => { if (!cancelled) setSnapshotEvents([]); });
        return () => { cancelled = true; };
    }, [isSubscriptionsRoute, user, networkGoingSnapshotEnabled]);

    const handleInterestChange = useCallback((next: InterestFilterChange) => {
        if (Object.prototype.hasOwnProperty.call(next, 'source')) {
            setInterestSource(next.source ?? null);
            if (next.source === null) setInterestUserHandles([]);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'kind')) {
            setInterestKind(next.kind!);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'match')) {
            setInterestMatch(next.match!);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'userHandles')) {
            const nextHandles = next.userHandles ?? [];
            setInterestUserHandles(nextHandles);
            setInterestSource((current) => (nextHandles.length > 0 && current === null ? 'follows' : current));
        }
    }, []);

    const showNetworkSnapshot = () => {
        setInterestUserHandles([]);
        setInterestKind('going');
        setInterestSource('follows');
    };

    // "Your Network" snapshot rows: upcoming going events grouped by event
    // with the going people attached, plus the distinct-people total.
    const snapshot = useMemo(() => {
        const now = Date.now();
        const distinctPeople = new Set<string>();
        const rows = snapshotEvents
            .filter((e) => new Date(e.end || e.start).getTime() >= now)
            .map((e) => {
                const goers = e.via
                    .filter((v) => v.kind === 'subscription_going')
                    .map((v) => v.actor);
                for (const a of goers) distinctPeople.add(a.handle);
                return { event: e, goers };
            })
            .filter((r) => r.goers.length > 0)
            .sort((a, b) => b.goers.length - a.goers.length);
        return { rows, peopleCount: distinctPeople.size };
    }, [snapshotEvents]);

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        trackView(evt.event_id, 'my-calendar');
        setSelectedEvent(evt);
    }, []);

    const handleBoundsChange = useCallback((bounds: MapBounds) => {
        setMapBounds(bounds);
    }, []);

    const handleExportIcs = useCallback(async () => {
        if (scopedEventIds.length === 0) return;
        setExporting('ics');
        try {
            const blob = await exportIcs(scopedEventIds);
            downloadBlob(blob, 'my-movida-events.ics');
            trackExportAction('ics', scopedEventIds.length);
        } catch { /* ignore */ }
        finally { setExporting(''); }
    }, [scopedEventIds]);

    const handleExportXlsx = useCallback(async () => {
        if (scopedEventIds.length === 0) return;
        setExporting('xlsx');
        try {
            const blob = await exportXlsx(scopedEventIds);
            downloadBlob(blob, 'my-movida-events.xlsx');
            trackExportAction('xlsx', scopedEventIds.length);
        } catch { /* ignore */ }
        finally { setExporting(''); }
    }, [scopedEventIds]);

    const handleSubscribe = useCallback(async () => {
        setFeedStatus('loading');
        try {
            const { token } = await createShareToken(getDeviceId());
            setFeedUrl(getCalendarFeedUrl(token, exportScope));
            setFeedStatus('idle');
            setSubscribeOpen(true);
        } catch {
            setFeedStatus('idle');
        }
    }, [exportScope]);

    const handleCopyFeedUrl = useCallback(async () => {
        if (!feedUrl) return;
        try {
            await navigator.clipboard.writeText(feedUrl);
            setFeedStatus('copied');
            setTimeout(() => setFeedStatus('idle'), 2500);
        } catch { /* ignore */ }
    }, [feedUrl]);

    const handleShare = useCallback(async () => {
        const deviceId = getDeviceId();
        setShareStatus('loading');
        try {
            const { token } = await createShareToken(deviceId);
            const url = `${window.location.origin}/shared/${token}`;
            const shareData = {
                title: 'My Movida Calendar',
                text: 'Check out the salsa events I\u2019m going to.',
                url,
            };
            if (typeof navigator.share === 'function') {
                try {
                    await navigator.share(shareData);
                    setShareStatus('idle');
                    return;
                } catch (err) {
                    if ((err as DOMException)?.name === 'AbortError') {
                        setShareStatus('idle');
                        return;
                    }
                }
            }
            await navigator.clipboard.writeText(url);
            setShareStatus('copied');
            setTimeout(() => setShareStatus('idle'), 2500);
        } catch {
            setShareStatus('idle');
        }
    }, []);

    useEffect(() => {
        if (!exportMenuOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (!exportMenuRef.current?.contains(e.target as Node)) setExportMenuOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setExportMenuOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [exportMenuOpen]);

    const stableEmptyEvents = useMemo(() => [] as CalendarEvent[], []);

    const displayedEvents = useMemo(() => {
        if (activeView === 'subs') return subsEvents;
        if (activeFilter === 'saved') return events.filter((e) => isSaved(e.event_id));
        if (activeFilter === 'going') return events.filter((e) => isAttending(e.event_id));
        return events;
    }, [activeView, subsEvents, activeFilter, events, isSaved, isAttending]);

    const { upcomingDisplayed, pastEventIds } = useMemo(() => {
        const now = Date.now();
        const pastIds = new Set<string>();
        const upcoming: CalendarEvent[] = [];
        for (const event of displayedEvents) {
            if (new Date(event.end).getTime() < now) {
                pastIds.add(event.event_id);
            } else {
                upcoming.push(event);
            }
        }
        return { upcomingDisplayed: upcoming, pastEventIds: pastIds };
    }, [displayedEvents]);

    const eventsForList = showPastEvents ? displayedEvents : upcomingDisplayed;
    const mapEvents = eventsForList.length > 0 ? eventsForList : stableEmptyEvents;
    const activeLoading = activeView === 'subs' ? subsLoading && subsEvents.length === 0 : loading;

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-4">
                {!user && allEventIds.length > 0 && !signInNudgeDismissed && (
                    <div className="mb-4 flex flex-wrap items-center gap-3 border border-line bg-canvas px-4 py-3 text-sm text-ink">
                        <p className="flex-1 min-w-[14rem]">
                            <span className="font-medium text-ink">Your calendar is taking shape.</span>{' '}
                            You&apos;ve already added {allEventIds.length} event{allEventIds.length === 1 ? '' : 's'}. Sign in to keep them synced across devices and ready to share.
                        </p>
                        <Link
                            to={`/login?next=${encodeURIComponent('/mine/calendar')}`}
                            className="shrink-0 bg-action px-4 py-1.5 text-xs font-medium text-white hover:bg-action transition"
                        >
                            Sign in
                        </Link>
                        <button
                            type="button"
                            onClick={dismissSignInNudge}
                            aria-label="Dismiss"
                            className="shrink-0 text-muted hover:text-ink text-lg leading-none px-1"
                        >
                            ×
                        </button>
                    </div>
                )}

                {activeView === 'mine' && allEventIds.length > 0 && (
                    <div className="mb-4 flex flex-wrap items-center gap-1.5">
                        {user && (
                            <MySubscribersBadge
                                mobileIconSrc="/rss.png"
                                className="shrink-0 inline-flex items-center gap-1 border border-line bg-surface px-2 py-1 text-xs font-medium text-ink hover:bg-canvas hover:text-action transition"
                            />
                        )}
                        <div ref={exportMenuRef} className="relative shrink-0">
                            <button
                                onClick={() => setExportMenuOpen((v) => !v)}
                                disabled={!!exporting}
                                aria-haspopup="menu"
                                aria-expanded={exportMenuOpen}
                                className="inline-flex items-center gap-1 border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-canvas transition disabled:opacity-50"
                            >
                                {exporting ? 'Exporting…' : (
                                    <>
                                        <span aria-hidden>📥</span>
                                        <span>Export</span>
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`}>
                                            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                                        </svg>
                                    </>
                                )}
                            </button>
                            {exportMenuOpen && (
                                <div role="menu" className="absolute left-0 top-full mt-1 w-56 bg-surface border border-line shadow-lg z-[9000]">
                                    <div className="px-3 pt-2 pb-1.5 border-b border-card-line">
                                        <div className="text-[10px] font-medium uppercase tracking-wide text-muted mb-1">Include</div>
                                        <div className="inline-flex w-full overflow-hidden rounded border border-line">
                                            {([
                                                { key: 'all' as Filter, label: 'All', count: allEventIds.length },
                                                { key: 'saved' as Filter, label: 'Saved', count: savedCount },
                                                { key: 'going' as Filter, label: 'Going', count: attendingCount },
                                            ]).map((opt) => (
                                                <button
                                                    key={opt.key}
                                                    type="button"
                                                    onClick={() => setExportScope(opt.key)}
                                                    aria-pressed={exportScope === opt.key}
                                                    className={`flex-1 px-1.5 py-1 text-[11px] transition ${exportScope === opt.key
                                                        ? 'bg-action text-white'
                                                        : 'bg-surface text-ink-soft hover:bg-canvas'
                                                        }`}
                                                >
                                                    {opt.label} ({opt.count})
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <button
                                        role="menuitem"
                                        disabled={scopedEventIds.length === 0}
                                        onClick={() => { setExportMenuOpen(false); handleExportIcs(); }}
                                        className="block w-full text-left px-3 py-1.5 text-xs text-ink hover:bg-canvas transition disabled:opacity-40"
                                    >
                                        📅 Export .ics
                                    </button>
                                    <button
                                        role="menuitem"
                                        disabled={scopedEventIds.length === 0}
                                        onClick={() => { setExportMenuOpen(false); handleExportXlsx(); }}
                                        className="block w-full text-left px-3 py-1.5 text-xs text-ink hover:bg-canvas transition disabled:opacity-40"
                                    >
                                        📊 Export .xlsx
                                    </button>
                                    {user && (
                                        <button
                                            role="menuitem"
                                            disabled={feedStatus === 'loading'}
                                            onClick={() => { setExportMenuOpen(false); handleSubscribe(); }}
                                            className="block w-full text-left px-3 py-1.5 text-xs text-ink hover:bg-canvas transition border-t border-card-line disabled:opacity-40"
                                        >
                                            📲 Subscribe in calendar app
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                        <button
                            onClick={handleShare}
                            disabled={shareStatus === 'loading'}
                            className="shrink-0 border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-canvas transition disabled:opacity-50 inline-flex items-center gap-1"
                        >
                            {shareStatus === 'copied' ? (
                                <>✓ Link copied!</>
                            ) : shareStatus === 'loading' ? (
                                <>Generating…</>
                            ) : (
                                <>
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                                        <path d="M13 4.5a2.5 2.5 0 1 1 .702 1.737L6.97 9.604a2.518 2.518 0 0 1 0 .792l6.733 3.367a2.5 2.5 0 1 1-.671 1.341l-6.733-3.367a2.5 2.5 0 1 1 0-3.475l6.733-3.367A2.52 2.52 0 0 1 13 4.5Z" />
                                    </svg>
                                    <span>Share</span>
                                </>
                            )}
                        </button>
                        {!activeLoading && pastEventIds.size > 0 && (
                            <button
                                onClick={() => setShowPastEvents((v) => !v)}
                                className="shrink-0 border border-line bg-surface px-2 py-1 text-xs text-ink-soft hover:bg-canvas transition"
                            >
                                {showPastEvents
                                    ? 'Hide past events'
                                    : `Show ${pastEventIds.size} past event${pastEventIds.size !== 1 ? 's' : ''}`}
                            </button>
                        )}
                    </div>
                )}

                {activeView === 'subs' && (
                    <div className="mb-4 flex flex-col gap-3">
                        {networkGoingSnapshotEnabled && user && snapshot.rows.length > 0 && (
                            <div className="border border-line bg-surface p-3.5">
                                <div className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                                    {snapshot.peopleCount} {snapshot.peopleCount === 1 ? 'person is' : 'people are'} attending upcoming events
                                </div>
                                <ul className="mt-3 divide-y divide-slate-100">
                                    {snapshot.rows.slice(0, 3).map(({ event, goers }) => {
                                        const names = goers.map((a) => firstNameOf(a.display_name, a.handle));
                                        const avatars = goers.slice(0, 5);
                                        return (
                                            <li key={event.event_id} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                                                <div className="flex shrink-0 -space-x-1">
                                                    {avatars.map((a, i) => {
                                                        // Show 3 avatars on mobile, 5 on desktop.
                                                        const hideOnMobile = i >= 3 ? ' max-sm:hidden' : '';
                                                        return a.avatar_url ? (
                                                            <img
                                                                key={a.handle}
                                                                src={a.avatar_url}
                                                                alt=""
                                                                loading="lazy"
                                                                className={'h-5 w-5 rounded-full object-cover ring-2 ring-white' + hideOnMobile}
                                                            />
                                                        ) : (
                                                            <span
                                                                key={a.handle}
                                                                className={'inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-ink-soft ring-2 ring-white' + hideOnMobile}
                                                            >
                                                                {(a.display_name || a.handle).slice(0, 1).toUpperCase()}
                                                            </span>
                                                        );
                                                    })}
                                                </div>
                                                <span className="shrink-0 max-w-[7rem] truncate text-xs font-semibold text-ink sm:hidden">
                                                    {formatNameList(names, 3)}
                                                </span>
                                                <span className="hidden shrink-0 text-xs font-semibold text-ink sm:inline">
                                                    {formatNameList(names, 5)}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => handleEventClick(event)}
                                                    title={event.title}
                                                    className="min-w-0 flex-1 truncate text-left text-xs font-medium text-ink hover:text-action"
                                                >
                                                    {event.title}
                                                </button>
                                                <span className="shrink-0 text-[11px] text-muted">
                                                    {formatRelativeWhen(event.start)}
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                                <button
                                    type="button"
                                    onClick={showNetworkSnapshot}
                                    className="mt-3 text-xs font-medium text-action hover:text-action"
                                >
                                    See all →
                                </button>
                            </div>
                        )}
                        <div className="flex min-w-0 items-start gap-2">
                            <div className="min-w-0 flex-1">
                                <InterestFilterChips
                                    signedIn={!!user}
                                    followingCount={subsCalendars.length}
                                    interestSource={interestSource}
                                    interestKind={interestKind}
                                    interestUserHandles={interestUserHandles}
                                    interestMatch={interestMatch}
                                    onChange={handleInterestChange}
                                    showShortcut={false}
                                />
                            </div>
                            {subsLoading && subsEvents.length > 0 && (
                                <span className="mt-1 shrink-0 text-[11px] text-muted">Updating…</span>
                            )}
                        </div>
                    </div>
                )}

                {activeView === 'mine' && showFilterTabs && (
                    <div className="mb-4 flex items-center gap-1">
                        {(['all', 'saved', 'going'] as Filter[]).map((f) => {
                            const label = f === 'all'
                                ? `All (${allEventIds.length})`
                                : f === 'saved'
                                    ? `Saved (${savedCount})`
                                    : `Going (${attendingCount})`;
                            return (
                                <button
                                    key={f}
                                    onClick={() => setActiveFilter(f)}
                                    className={`px-2 py-0.5 text-[11px] font-medium leading-5 border transition ${activeFilter === f
                                        ? 'bg-blue-100 border-blue-200 text-action'
                                        : 'bg-surface border-line text-ink-soft hover:border-action hover:text-action'
                                        }`}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                )}


                {activeLoading && (
                    <p className="text-center text-muted py-12">Loading your events…</p>
                )}

                {!activeLoading && activeView === 'mine' && allEventIds.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-10 h-10 text-slate-300 mb-4">
                            <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                        </svg>
                        <p className="text-ink-soft text-lg font-medium">No events yet</p>
                        <p className="text-muted text-sm mt-1">
                            Save events or mark "I'm going" to build your personal calendar.
                        </p>
                        <Link
                            to="/"
                            className="mt-6 inline-flex items-center gap-1.5 bg-action hover:bg-action text-white text-sm font-semibold px-5 py-2 shadow-sm transition"
                        >
                            Browse events →
                        </Link>
                    </div>
                )}

                {!activeLoading && activeView === 'subs' && !subsLoading && subsEvents.length === 0 && (() => {
                    const filterActive = interestSource !== null || interestUserHandles.length > 0;
                    return subsCalendars.length === 0 && !filterActive ? (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <p className="text-ink-soft text-lg font-medium">
                                Build your tribe
                            </p>
                            <p className="text-muted text-sm mt-1">
                                Follow other dancers to see the events they’re going to and saving.
                            </p>
                            <Link
                                to="/tribe/discover"
                                className="mt-6 inline-flex items-center gap-1.5 bg-action hover:bg-action text-white text-sm font-semibold px-5 py-2 shadow-sm transition"
                            >
                                Discover people →
                            </Link>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <p className="text-ink-soft text-lg font-medium">
                                No upcoming events from your subscriptions
                            </p>
                            <p className="text-muted text-sm mt-1">
                                {filterActive
                                    ? 'Those people have no matching upcoming events yet.'
                                    : 'When the calendars you subscribe to publish events, they’ll show up here.'}
                            </p>
                            {filterActive && (
                                <button
                                    type="button"
                                    onClick={() => { setInterestUserHandles([]); setInterestSource(null); }}
                                    className="mt-4 text-xs text-action hover:underline"
                                >
                                    Show all subscriptions
                                </button>
                            )}
                        </div>
                    );
                })()}

                {!activeLoading && (
                    (activeView === 'mine' && allEventIds.length > 0) ||
                    (activeView === 'subs' && subsEvents.length > 0)
                ) && (
                        <div className="flex flex-col lg:flex-row gap-6">
                            <div className="order-1 lg:order-1 lg:w-[350px] lg:shrink-0 flex flex-col gap-4">
                                <div className="hidden lg:block lg:h-[calc(100vh-220px)] lg:overflow-hidden">
                                    <EventListPanel
                                        events={eventsForList}
                                        pastEventIds={showPastEvents ? pastEventIds : undefined}
                                        mapBounds={mapBounds}
                                        onEventClick={handleEventClick}
                                        showPrices={showPrices}
                                        showPopularity={showPopularity}
                                        sortBy={sortBy}
                                        onSortChange={setSortBy}
                                        orderByFollows={activeView === 'subs'}
                                    />
                                </div>
                            </div>
                            <div className="order-2 lg:order-2 h-[194px] lg:flex-1 lg:h-[calc(100vh-220px)] lg:sticky lg:top-6">
                                <EventMap
                                    events={mapEvents}
                                    focusedEvent={selectedEvent}
                                    onEventClick={handleEventClick}
                                    onBoundsChange={handleBoundsChange}
                                    popularityThreshold={popularityThreshold}
                                />
                            </div>
                            <div className="order-3 lg:hidden">
                                <EventListPanel
                                    events={eventsForList}
                                    pastEventIds={showPastEvents ? pastEventIds : undefined}
                                    mapBounds={mapBounds}
                                    onEventClick={handleEventClick}
                                    showPrices={showPrices}
                                    showPopularity={showPopularity}
                                    sortBy={sortBy}
                                    onSortChange={setSortBy}
                                    orderByFollows={activeView === 'subs'}
                                />
                            </div>
                        </div>
                    )}

                {selectedEvent && (
                    <EventModal
                        event={selectedEvent}
                        onClose={() => setSelectedEvent(null)}
                    />
                )}

                {subscribeOpen && (
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label="Subscribe in your calendar app"
                        className="fixed inset-0 z-[9500] flex items-center justify-center bg-black/40 p-4"
                        onClick={() => setSubscribeOpen(false)}
                    >
                        <div
                            className="w-full max-w-md bg-surface shadow-xl"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center justify-between border-b border-line px-4 py-3">
                                <h2 className="text-sm font-semibold text-ink">Subscribe in your calendar app</h2>
                                <button
                                    onClick={() => setSubscribeOpen(false)}
                                    aria-label="Close"
                                    className="text-muted hover:text-ink-soft"
                                >
                                    ✕
                                </button>
                            </div>
                            <div className="px-4 py-3 space-y-3">
                                <p className="text-xs text-ink-soft">
                                    Your {exportScope === 'all' ? 'saved & going' : exportScope} events stay in sync in Apple
                                    or Google Calendar. The feed updates automatically when you save or join events.
                                </p>
                                <div className="flex items-stretch gap-1.5">
                                    <input
                                        readOnly
                                        value={feedUrl}
                                        onFocus={(e) => e.currentTarget.select()}
                                        className="min-w-0 flex-1 border border-line bg-canvas px-2 py-1.5 text-xs text-ink"
                                    />
                                    <button
                                        onClick={handleCopyFeedUrl}
                                        className="shrink-0 bg-action px-3 py-1.5 text-xs text-white hover:bg-action transition"
                                    >
                                        {feedStatus === 'copied' ? '✓ Copied' : 'Copy'}
                                    </button>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    <a
                                        href={feedUrl.replace(/^https?:/, 'webcal:')}
                                        className="inline-flex items-center gap-1 border border-line bg-surface px-2.5 py-1.5 text-xs text-ink hover:bg-canvas transition"
                                    >
                                        🍎 Add to Apple Calendar
                                    </a>
                                    <a
                                        href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedUrl)}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 border border-line bg-surface px-2.5 py-1.5 text-xs text-ink hover:bg-canvas transition"
                                    >
                                        📆 Add to Google Calendar
                                    </a>
                                </div>
                                <p className="text-[11px] text-muted">
                                    Anyone with this link can see these events. Keep it private.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}

export default function MyCalendar() {
    const { pathname } = useLocation();
    return pathname === '/mine/calendar' ? <MyEventsExperience /> : <LegacyCalendar />;
}
