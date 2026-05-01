import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchEventsByIds, exportIcs, exportXlsx, createShareToken } from '../api';
import { getDeviceId } from '../utils/deviceId';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { trackExportAction, trackView } from '../utils/tracking';
import EventListPanel from '../components/EventListPanel';
import EventMap from '../components/EventMap';
import type { MapBounds } from '../components/EventMap';
import EventModal from '../components/EventModal';
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
    const { savedEventIds, savedCount, isSaved, clearAll } = useSavedEvents();
    const { attendingEventIds, attendingCount, isAttending } = useAttendingEvents();
    const { showPrices, showPopularity } = useFeatureFlags();
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
    const [sortBy, setSortBy] = useState<'date' | 'popularity'>('date');
    const [exporting, setExporting] = useState('');
    const [shareStatus, setShareStatus] = useState<'idle' | 'loading' | 'copied'>('idle');
    const [activeFilter, setActiveFilter] = useState<Filter>('all');
    const [showPastEvents, setShowPastEvents] = useState(false);

    // Union of saved + going — deduplicated
    const allEventIds = useMemo(
        () => [...new Set([...savedEventIds, ...attendingEventIds])],
        [savedEventIds, attendingEventIds],
    );

    const showFilterTabs = savedCount > 0 && attendingCount > 0;

    useEffect(() => {
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
    }, [allEventIds]);

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        trackView(evt.event_id, 'my-calendar');
        setSelectedEvent(evt);
    }, []);

    const handleBoundsChange = useCallback((bounds: MapBounds) => {
        setMapBounds(bounds);
    }, []);

    const handleExportIcs = useCallback(async () => {
        if (allEventIds.length === 0) return;
        setExporting('ics');
        try {
            const blob = await exportIcs(allEventIds);
            downloadBlob(blob, 'my-movida-events.ics');
            trackExportAction('ics', allEventIds.length);
        } catch { /* ignore */ }
        finally { setExporting(''); }
    }, [allEventIds]);

    const handleExportXlsx = useCallback(async () => {
        if (allEventIds.length === 0) return;
        setExporting('xlsx');
        try {
            const blob = await exportXlsx(allEventIds);
            downloadBlob(blob, 'my-movida-events.xlsx');
            trackExportAction('xlsx', allEventIds.length);
        } catch { /* ignore */ }
        finally { setExporting(''); }
    }, [allEventIds]);

    const handleShare = useCallback(async () => {
        const deviceId = getDeviceId();
        setShareStatus('loading');
        try {
            const { token } = await createShareToken(deviceId);
            await navigator.clipboard.writeText(`${window.location.origin}/shared/${token}`);
            setShareStatus('copied');
            setTimeout(() => setShareStatus('idle'), 2500);
        } catch {
            setShareStatus('idle');
        }
    }, []);

    // Memoize empty array for the no-events case to keep EventMap stable
    const stableEmptyEvents = useMemo(() => [] as CalendarEvent[], []);

    // Events filtered by active tab
    const displayedEvents = useMemo(() => {
        if (activeFilter === 'saved') return events.filter((e) => isSaved(e.event_id));
        if (activeFilter === 'going') return events.filter((e) => isAttending(e.event_id));
        return events;
    }, [activeFilter, events, isSaved, isAttending]);

    // Split into upcoming / past
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

    // Header count label
    const countLabel = useMemo(() => {
        if (savedCount > 0 && attendingCount > 0) {
            return `${savedCount} saved · ${attendingCount} going`;
        }
        if (savedCount > 0) return `${savedCount} saved`;
        if (attendingCount > 0) return `${attendingCount} going`;
        return null;
    }, [savedCount, attendingCount]);

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-4">
                {/* Header */}
                <div className="mb-4 flex flex-wrap items-center gap-3">
                    <Link to="/" className="text-sm text-rose-600 hover:underline shrink-0">
                        ← Back
                    </Link>
                    <h1 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-slate-700">
                            <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                        </svg>
                        My Calendar
                        {countLabel && (
                            <span className="ml-2 text-sm font-normal text-slate-500">
                                ({countLabel})
                            </span>
                        )}
                    </h1>
                    {allEventIds.length > 0 && (
                        <div className="ml-auto flex items-center gap-2">
                            <button
                                onClick={handleExportIcs}
                                disabled={!!exporting}
                                className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 hover:bg-slate-200 transition disabled:opacity-50"
                            >
                                {exporting === 'ics' ? 'Exporting…' : '📅 Export .ics'}
                            </button>
                            <button
                                onClick={handleExportXlsx}
                                disabled={!!exporting}
                                className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 hover:bg-slate-200 transition disabled:opacity-50"
                            >
                                {exporting === 'xlsx' ? 'Exporting…' : '📊 Export .xlsx'}
                            </button>
                            <button
                                onClick={handleShare}
                                disabled={shareStatus === 'loading'}
                                className="rounded-full bg-rose-50 px-3 py-1 text-xs text-rose-600 hover:bg-rose-100 transition disabled:opacity-50"
                            >
                                {shareStatus === 'copied' ? '✓ Link copied!' : shareStatus === 'loading' ? 'Generating…' : '🔗 Share'}
                            </button>
                            <button
                                onClick={clearAll}
                                className="rounded-full bg-red-50 px-3 py-1 text-xs text-red-600 hover:bg-red-100 transition"
                            >
                                Clear all
                            </button>
                        </div>
                    )}
                </div>

                {/* Filter tabs — only when both saved and going events exist */}
                {showFilterTabs && (
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
                                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${activeFilter === f
                                        ? 'bg-slate-800 text-white'
                                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                        }`}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Past events toggle */}
                {!loading && pastEventIds.size > 0 && (
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

                {loading && (
                    <p className="text-center text-slate-400 py-12">Loading your events…</p>
                )}

                {!loading && allEventIds.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-10 h-10 text-slate-300 mb-4">
                            <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                        </svg>
                        <p className="text-slate-600 text-lg font-medium">No events yet</p>
                        <p className="text-slate-400 text-sm mt-1">
                            Save events or mark "I'm going" to build your personal calendar.
                        </p>
                        <Link to="/" className="mt-6 text-sm text-slate-600 hover:underline">
                            ← Browse events
                        </Link>
                    </div>
                )}

                {!loading && allEventIds.length > 0 && (
                    <div className="flex flex-col lg:flex-row gap-6">
                        {/* Left: Event list */}
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
                        {/* Right: Map */}
                        <div className="order-2 lg:order-2 h-[400px] lg:flex-1 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6">
                            <EventMap
                                events={mapEvents}
                                focusedEvent={selectedEvent}
                                onEventClick={handleEventClick}
                                onBoundsChange={handleBoundsChange}
                            />
                        </div>
                        {/* Mobile list */}
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
            </main>
        </div>
    );
}
