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
    type SubscribedUser,
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
import type { CalendarEvent } from '../types';

type Filter = 'all' | 'saved' | 'going';

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

export default function MyCalendar() {
    const location = useLocation();
    const navigate = useNavigate();
    const { savedEventIds, savedCount, isSaved, clearAll } = useSavedEvents();
    const { attendingEventIds, attendingCount, isAttending } = useAttendingEvents();
    const { showPrices, showPopularity, popularityThreshold } = useFeatureFlags();
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
    const [activeFilter, setActiveFilter] = useState<Filter>('all');
    const [showPastEvents, setShowPastEvents] = useState(false);
    const [subsEvents, setSubsEvents] = useState<CalendarEvent[]>([]);
    const [subsLoading, setSubsLoading] = useState(false);
    const [subsCalendars, setSubsCalendars] = useState<SubscribedUser[]>([]);
    const [subsHandleFilters, setSubsHandleFilters] = useState<string[]>([]);
    const [subsFilter, setSubsFilter] = useState<Filter>('all');
    const [signInNudgeDismissed, setSignInNudgeDismissed] = useState<boolean>(() => {
        if (typeof window === 'undefined') return false;
        return window.localStorage.getItem('myCalendar.signInNudge.dismissed') === '1';
    });
    const dismissSignInNudge = useCallback(() => {
        setSignInNudgeDismissed(true);
        try { window.localStorage.setItem('myCalendar.signInNudge.dismissed', '1'); } catch { /* ignore quota */ }
    }, []);

    const isSubscriptionsRoute = location.pathname === '/my-calendar/subscriptions';
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
            navigate(`/login?next=${encodeURIComponent('/my-calendar/subscriptions')}`, { replace: true });
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
            return;
        }
        let cancelled = false;
        fetchMySubscriptions({ limit: 50 })
            .then((res) => {
                if (cancelled) return;
                setSubsCalendars(res.items);
            })
            .catch(() => { /* tolerate; pills just won't appear */ });
        return () => { cancelled = true; };
    }, [user]);

    useEffect(() => {
        if (!isSubscriptionsRoute || !user) return;
        let cancelled = false;
        setSubsLoading(true);
        fetchSubscribedEvents({
            fromHandles: subsHandleFilters,
            kind: subsFilter,
            limit: 100,
        })
            .then((res) => {
                if (cancelled) return;
                setSubsEvents(res.items);
            })
            .catch(() => { if (!cancelled) setSubsEvents([]); })
            .finally(() => { if (!cancelled) setSubsLoading(false); });
        return () => { cancelled = true; };
    }, [isSubscriptionsRoute, user, subsHandleFilters, subsFilter]);

    const toggleSubsHandle = useCallback((handle: string) => {
        setSubsHandleFilters((current) => current.includes(handle)
            ? [] // If already selected, deselect
            : [handle]); // If not selected, select only this one (exclusive)
    }, []);

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

    const handleBack = () => {
        if (window.history.length > 1) navigate(-1);
        else navigate('/');
    };

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-4">
                {!user && allEventIds.length > 0 && !signInNudgeDismissed && (
                    <div className="mb-4 flex flex-wrap items-center gap-3 border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                        <p className="flex-1 min-w-[14rem]">
                            <span className="font-medium text-slate-800">Your calendar is taking shape.</span>{' '}
                            You&apos;ve already added {allEventIds.length} event{allEventIds.length === 1 ? '' : 's'}. Sign in to keep them synced across devices and ready to share.
                        </p>
                        <Link
                            to={`/login?next=${encodeURIComponent('/my-calendar')}`}
                            className="shrink-0 bg-blue-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-600 transition"
                        >
                            Sign in
                        </Link>
                        <button
                            type="button"
                            onClick={dismissSignInNudge}
                            aria-label="Dismiss"
                            className="shrink-0 text-slate-400 hover:text-slate-700 text-lg leading-none px-1"
                        >
                            ×
                        </button>
                    </div>
                )}

                <div className="mb-4 border-b border-slate-200 flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1">
                        {user && subsCalendars.length > 0 ? (
                            ([
                                { key: 'mine' as const, label: 'My events' },
                                {
                                    key: 'subs' as const,
                                    label: `From people I follow${subsCalendars.length > 0 ? ` (${subsCalendars.length})` : ''}`,
                                },
                            ]).map((t) => (
                                <button
                                    key={t.key}
                                    type="button"
                                    onClick={() => navigate(t.key === 'subs' ? '/my-calendar/subscriptions' : '/my-calendar')}
                                    className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${activeView === t.key
                                        ? 'border-blue-500 text-blue-600'
                                        : 'border-transparent text-slate-500 hover:text-slate-700'
                                        }`}
                                >
                                    {t.label}
                                </button>
                            ))
                        ) : (
                            <span className="px-3 py-2 text-sm font-medium border-b-2 border-blue-500 -mb-px text-blue-600">
                                My events
                            </span>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={handleBack}
                        className="shrink-0 text-sm text-slate-600 hover:underline"
                    >
                        ← Back
                    </button>
                </div>

                {activeView === 'mine' && allEventIds.length > 0 && (
                    <div className="mb-4 flex flex-wrap items-center gap-1.5">
                        {user && (
                            <MySubscribersBadge
                                mobileIconSrc="/rss.png"
                                className="shrink-0 inline-flex items-center gap-1 border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 hover:text-blue-700 transition"
                            />
                        )}
                        <div ref={exportMenuRef} className="relative shrink-0">
                            <button
                                onClick={() => setExportMenuOpen((v) => !v)}
                                disabled={!!exporting}
                                aria-haspopup="menu"
                                aria-expanded={exportMenuOpen}
                                className="inline-flex items-center gap-1 border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 transition disabled:opacity-50"
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
                                <div role="menu" className="absolute left-0 top-full mt-1 w-56 bg-white border border-slate-200 shadow-lg z-[9000]">
                                    <div className="px-3 pt-2 pb-1.5 border-b border-slate-100">
                                        <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400 mb-1">Include</div>
                                        <div className="inline-flex w-full overflow-hidden rounded border border-slate-200">
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
                                                        ? 'bg-blue-500 text-white'
                                                        : 'bg-white text-slate-600 hover:bg-slate-50'
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
                                        className="block w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition disabled:opacity-40"
                                    >
                                        📅 Export .ics
                                    </button>
                                    <button
                                        role="menuitem"
                                        disabled={scopedEventIds.length === 0}
                                        onClick={() => { setExportMenuOpen(false); handleExportXlsx(); }}
                                        className="block w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition disabled:opacity-40"
                                    >
                                        📊 Export .xlsx
                                    </button>
                                    {user && (
                                        <button
                                            role="menuitem"
                                            disabled={feedStatus === 'loading'}
                                            onClick={() => { setExportMenuOpen(false); handleSubscribe(); }}
                                            className="block w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition border-t border-slate-100 disabled:opacity-40"
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
                            className="shrink-0 bg-blue-500 px-2 py-1 text-xs text-white hover:bg-blue-600 transition disabled:opacity-50 inline-flex items-center gap-1"
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
                        <button
                            onClick={clearAll}
                            className="shrink-0 border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 transition"
                        >
                            Clear all
                        </button>
                    </div>
                )}

                {activeView === 'subs' && subsCalendars.length > 0 && (
                    <div className="mb-4 flex flex-col gap-2">
                        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                            <button
                                type="button"
                                onClick={() => setSubsHandleFilters([])}
                                className={`shrink-0 px-2.5 py-1 text-xs font-medium border transition ${subsHandleFilters.length === 0
                                    ? 'bg-blue-500 border-blue-500 text-white'
                                    : 'bg-white border-slate-200 text-slate-600 hover:border-blue-500 hover:text-blue-500'
                                    }`}
                            >
                                Everyone
                            </button>
                            {subsCalendars.map((s) => {
                                const selected = subsHandleFilters.includes(s.handle);
                                return (
                                    <button
                                        key={s.handle}
                                        type="button"
                                        onClick={() => toggleSubsHandle(s.handle)}
                                        aria-pressed={selected}
                                        className={`shrink-0 px-2.5 py-1 text-xs font-medium border transition inline-flex items-center gap-1.5 ${selected
                                            ? 'bg-blue-500 border-blue-500 text-white'
                                            : 'bg-white border-slate-200 text-slate-600 hover:border-blue-500 hover:text-blue-500'
                                            }`}
                                        title={`Toggle events from @${s.handle}`}
                                    >
                                        {s.avatar_url ? (
                                            <img
                                                src={s.avatar_url}
                                                alt=""
                                                className="h-4 w-4 rounded-full object-cover"
                                                loading="lazy"
                                            />
                                        ) : (
                                            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-slate-600">
                                                {(s.display_name || s.handle).slice(0, 1).toUpperCase()}
                                            </span>
                                        )}
                                        <span>@{s.handle}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex items-center gap-1">
                            {(['all', 'saved', 'going'] as Filter[]).map((f) => (
                                <button
                                    key={f}
                                    type="button"
                                    onClick={() => setSubsFilter(f)}
                                    className={`px-2 py-0.5 text-[11px] font-medium leading-5 border transition ${subsFilter === f
                                        ? 'bg-blue-500 border-blue-500 text-white'
                                        : 'bg-white border-slate-200 text-slate-600 hover:border-blue-500 hover:text-blue-500'
                                        }`}
                                >
                                    {f === 'all' ? 'All' : f === 'saved' ? 'Saved' : 'Going'}
                                </button>
                            ))}
                            {subsLoading && subsEvents.length > 0 && (
                                <span className="ml-2 text-[11px] text-slate-400">Updating…</span>
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
                                        ? 'bg-blue-500 border-blue-500 text-white'
                                        : 'bg-white border-slate-200 text-slate-600 hover:border-blue-500 hover:text-blue-500'
                                        }`}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                )}

                {!activeLoading && activeView === 'mine' && pastEventIds.size > 0 && (
                    <div className="mb-3">
                        <button
                            onClick={() => setShowPastEvents((v) => !v)}
                            className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2 transition"
                        >
                            {showPastEvents
                                ? 'Hide past events'
                                : `Show ${pastEventIds.size} past event${pastEventIds.size !== 1 ? 's' : ''}`}
                        </button>
                    </div>
                )}

                {activeLoading && (
                    <p className="text-center text-slate-400 py-12">Loading your events…</p>
                )}

                {!activeLoading && activeView === 'mine' && allEventIds.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-10 h-10 text-slate-300 mb-4">
                            <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                        </svg>
                        <p className="text-slate-600 text-lg font-medium">No events yet</p>
                        <p className="text-slate-400 text-sm mt-1">
                            Save events or mark "I'm going" to build your personal calendar.
                        </p>
                        <Link
                            to="/"
                            className="mt-6 inline-flex items-center gap-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold px-5 py-2 shadow-sm transition"
                        >
                            Browse events →
                        </Link>
                    </div>
                )}

                {!activeLoading && activeView === 'subs' && !subsLoading && subsEvents.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <p className="text-slate-600 text-lg font-medium">
                            No upcoming events from your subscriptions
                        </p>
                        <p className="text-slate-400 text-sm mt-1">
                            {subsHandleFilters.length > 0
                                ? 'Those people have no matching upcoming events yet.'
                                : 'When the calendars you subscribe to publish events, they’ll show up here.'}
                        </p>
                        {subsHandleFilters.length > 0 && (
                            <button
                                type="button"
                                onClick={() => setSubsHandleFilters([])}
                                className="mt-4 text-xs text-blue-600 hover:underline"
                            >
                                Show all subscriptions
                            </button>
                        )}
                    </div>
                )}

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
                            className="w-full max-w-md bg-white shadow-xl"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                                <h2 className="text-sm font-semibold text-slate-800">Subscribe in your calendar app</h2>
                                <button
                                    onClick={() => setSubscribeOpen(false)}
                                    aria-label="Close"
                                    className="text-slate-400 hover:text-slate-600"
                                >
                                    ✕
                                </button>
                            </div>
                            <div className="px-4 py-3 space-y-3">
                                <p className="text-xs text-slate-500">
                                    Your {exportScope === 'all' ? 'saved & going' : exportScope} events stay in sync in Apple
                                    or Google Calendar. The feed updates automatically when you save or join events.
                                </p>
                                <div className="flex items-stretch gap-1.5">
                                    <input
                                        readOnly
                                        value={feedUrl}
                                        onFocus={(e) => e.currentTarget.select()}
                                        className="min-w-0 flex-1 border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-700"
                                    />
                                    <button
                                        onClick={handleCopyFeedUrl}
                                        className="shrink-0 bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600 transition"
                                    >
                                        {feedStatus === 'copied' ? '✓ Copied' : 'Copy'}
                                    </button>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    <a
                                        href={feedUrl.replace(/^https?:/, 'webcal:')}
                                        className="inline-flex items-center gap-1 border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition"
                                    >
                                        🍎 Add to Apple Calendar
                                    </a>
                                    <a
                                        href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedUrl)}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition"
                                    >
                                        📆 Add to Google Calendar
                                    </a>
                                </div>
                                <p className="text-[11px] text-slate-400">
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
