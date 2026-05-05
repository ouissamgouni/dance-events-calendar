import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { CalendarEvent, TagGroup } from '../types';
import { fetchEvents, fetchSettings, fetchTagGroups } from '../api';
import { trackView } from '../utils/tracking';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type FullCalendar from '@fullcalendar/react';
import Calendar from '../components/Calendar';
import type { CalendarViewMode } from '../components/Calendar';
import EventMap from '../components/EventMap';
import type { MapBounds } from '../components/EventMap';
import EventModal from '../components/EventModal';
import AdminEventDetailPanel from '../components/AdminEventDetailPanel';
import DateRangePicker from '../components/DateRangePicker';
import EventListPanel from '../components/EventListPanel';
import TagFilterPills from '../components/TagFilterPills';
import SavedEventsFab from '../components/SavedEventsFab';
import SuggestEventModal from '../components/SuggestEventModal';
import EventAnchoredDetailPanel from '../components/EventAnchoredDetailPanel';

type ViewMode = 'explorer' | 'calendar';

function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

export default function Home() {
    const { user } = useAuth();
    const { showPrices, showPopularity, popularityThreshold } = useFeatureFlags();
    const [showSuggestModal, setShowSuggestModal] = useState(false);
    const location = useLocation();
    const viewMode: ViewMode = location.pathname === '/calendar' ? 'calendar' : 'explorer';
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [sinceDate, setSinceDate] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [selectedEventSource, setSelectedEventSource] = useState<string | null>(null);
    const [editingEventId, setEditingEventId] = useState<string | null>(null);
    const [sortBy, setSortBy] = useState<'date' | 'popularity'>('date');
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [activeTagIds, setActiveTagIds] = useState<Set<number>>(new Set());

    // Calendar view section visibility
    const [showCalendarGrid, setShowCalendarGrid] = useState(true);
    const [showCalendarMap, setShowCalendarMap] = useState(true);

    // Mobile calendar view: 3-week (default on mobile) vs full month. Persisted.
    const [isMobileViewport, setIsMobileViewport] = useState(() => window.innerWidth < 640);
    useEffect(() => {
        const mq = window.matchMedia('(max-width: 639px)');
        const handler = (e: MediaQueryListEvent) => setIsMobileViewport(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);
    const [mobileCalendarView, setMobileCalendarView] = useState<CalendarViewMode>(() => {
        const stored = typeof window !== 'undefined' ? window.localStorage.getItem('mobileCalendarView') : null;
        return stored === 'month' ? 'month' : '3week';
    });
    useEffect(() => {
        try {
            window.localStorage.setItem('mobileCalendarView', mobileCalendarView);
        } catch { /* ignore */ }
    }, [mobileCalendarView]);
    const calendarViewMode: CalendarViewMode = isMobileViewport ? mobileCalendarView : 'month';

    // Shared selection anchor for calendar desktop details
    const [selectedEventRect, setSelectedEventRect] = useState<DOMRect | null>(null);

    // Responsive: detect desktop for explorer detail swap
    const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 1024);
    useEffect(() => {
        const handler = () => setIsDesktop(window.innerWidth >= 1024);
        window.addEventListener('resize', handler);
        return () => window.removeEventListener('resize', handler);
    }, []);

    // Explorer state
    const today = formatDate(new Date());
    const defaultEndDate = new Date();
    defaultEndDate.setMonth(defaultEndDate.getMonth() + 1);
    const [startDate, setStartDate] = useState(today);
    const [endDate, setEndDate] = useState(formatDate(defaultEndDate));
    const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);

    // Calendar mode map bounds (for off-map styling in the calendar grid)
    const [calMapBounds, setCalMapBounds] = useState<MapBounds | null>(null);

    const navigate = useNavigate();

    // Cross-component hover highlight
    const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
    const handleEventHover = useCallback((eventId: string | null) => {
        setHoveredEventId(eventId);
    }, []);

    // Calendar state
    const [visibleRange, setVisibleRange] = useState<{ start: Date; end: Date } | null>(null);

    // Fetch events when date range changes (explorer mode) or visible range changes (calendar mode)
    const initialLoadDone = useRef(false);
    useEffect(() => {
        // Only show full loading spinner on first load — subsequent fetches
        // must NOT unmount the Calendar (which resets FullCalendar's month).
        if (!initialLoadDone.current) setLoading(true);
        let params: { startDate?: string; endDate?: string } | undefined;
        if (viewMode === 'explorer') {
            params = { startDate, endDate };
        } else if (visibleRange) {
            params = {
                startDate: formatDate(visibleRange.start),
                endDate: formatDate(visibleRange.end),
            };
        } else {
            // Calendar mode initial load: use same default as explorer
            params = { startDate, endDate };
        }
        const tagParams = params?.startDate || params?.endDate ? params : undefined;
        Promise.all([fetchEvents(params), fetchSettings(), fetchTagGroups(tagParams)])
            .then(([evts, settings, groups]) => {
                setEvents(evts);
                setSinceDate(settings.since_date);
                setTagGroups(groups);
            })
            .catch((e) => setError(e.message))
            .finally(() => {
                setLoading(false);
                initialLoadDone.current = true;
            });
    }, [viewMode, startDate, endDate, visibleRange]);

    const handleDateRangeChange = useCallback((start: string, end: string) => {
        setStartDate(start);
        setEndDate(end);
    }, []);

    const handleToggleTag = useCallback((tagId: number) => {
        setActiveTagIds((prev) => {
            const next = new Set(prev);
            if (next.has(tagId)) next.delete(tagId);
            else next.add(tagId);
            return next;
        });
    }, []);

    const handleClearTags = useCallback(() => {
        setActiveTagIds(new Set());
    }, []);

    const filteredEvents = useMemo(() => {
        let result = events;
        if (activeTagIds.size > 0) {
            result = result.filter((e) =>
                [...activeTagIds].every((tagId) => e.tags?.some((t) => t.id === tagId))
            );
        }
        return result;
    }, [events, activeTagIds]);

    const handleDatesChange = useCallback((start: Date, end: Date) => {
        setVisibleRange((prev) => {
            if (prev && prev.start.getTime() === start.getTime() && prev.end.getTime() === end.getTime()) {
                return prev;
            }
            return { start, end };
        });
    }, []);

    const calendarVisibleEvents = useMemo(() => {
        if (!visibleRange) return filteredEvents;
        return filteredEvents.filter((e) => {
            const eventStart = new Date(e.start);
            const eventEnd = new Date(e.end || e.start);
            return eventEnd >= visibleRange.start && eventStart < visibleRange.end;
        });
    }, [filteredEvents, visibleRange]);

    const handleEventClick = useCallback((evt: CalendarEvent, clickRect?: DOMRect) => {
        if (viewMode === 'explorer') {
            // Navigate to the event detail page
            navigate(`/event/${evt.event_id}`);
        } else {
            setSelectedEventRect(clickRect ?? null);
            setSelectedEventSource('calendar-modal');
            setSelectedEvent(evt);
        }
    }, [viewMode, navigate]);

    // Calendar-mode map marker click — fires its own trackView (no double-fire with Calendar grid)
    const handleCalMapEventClick = useCallback((evt: CalendarEvent) => {
        trackView(evt.event_id, 'calendar-map');
        setSelectedEventRect(null);
        setSelectedEventSource('calendar-map-modal');
        setSelectedEvent(evt);
    }, []);

    // Explorer list panel click — carries source through URL query param
    const handleExplorerListEventClick = useCallback((evt: CalendarEvent) => {
        navigate(`/event/${evt.event_id}?src=explorer-list`);
    }, [navigate]);

    // Explorer map marker click — carries source through URL query param
    const handleExplorerMapEventClick = useCallback((evt: CalendarEvent) => {
        navigate(`/event/${evt.event_id}?src=explorer-map`);
    }, [navigate]);

    const handleCloseModal = useCallback(() => {
        setSelectedEventRect(null);
        setSelectedEvent(null);
    }, []);

    const handleEditEvent = useCallback((evt: CalendarEvent) => {
        setSelectedEventRect(null);
        setSelectedEvent(null);
        setEditingEventId(evt.event_id);
    }, []);

    const handleCloseEdit = useCallback(() => {
        setEditingEventId(null);
        // Refresh events list so any admin edits propagate to other surfaces.
        const params = viewMode === 'explorer'
            ? { startDate, endDate }
            : visibleRange
                ? { startDate: formatDate(visibleRange.start), endDate: formatDate(visibleRange.end) }
                : { startDate, endDate };
        fetchEvents(params).then(setEvents).catch(() => { });
    }, [viewMode, startDate, endDate, visibleRange]);

    const handleBoundsChange = useCallback((bounds: MapBounds) => {
        setMapBounds(bounds);
    }, []);

    const handleCalBoundsChange = useCallback((bounds: MapBounds) => {
        setCalMapBounds(bounds);
    }, []);

    // Set of event IDs not visible on the calendar-mode map
    const offMapEventIds = useMemo(() => {
        if (!calMapBounds || !showCalendarMap) return new Set<string>();
        return new Set(
            calendarVisibleEvents
                .filter((e) => {
                    if (e.latitude == null || e.longitude == null) return true;
                    return !(
                        e.latitude >= calMapBounds.south &&
                        e.latitude <= calMapBounds.north &&
                        e.longitude >= calMapBounds.west &&
                        e.longitude <= calMapBounds.east
                    );
                })
                .map((e) => e.event_id),
        );
    }, [calendarVisibleEvents, calMapBounds, showCalendarMap]);

    // Calendar ref + navigation (FC is always mounted in calendar mode)
    const calendarRef = useRef<FullCalendar>(null);

    const handleCalPrev = useCallback(() => calendarRef.current?.getApi().prev(), []);
    const handleCalNext = useCallback(() => calendarRef.current?.getApi().next(), []);
    const handleCalToday = useCallback(() => calendarRef.current?.getApi().today(), []);

    const calendarTitle = useMemo(() => {
        if (!visibleRange) return '';
        const spanDays = (visibleRange.end.getTime() - visibleRange.start.getTime()) / (1000 * 60 * 60 * 24);
        // Month view spans ~5-6 weeks (35-42 days). 3-week view spans 21 days.
        if (spanDays <= 28) {
            const start = visibleRange.start;
            // FullCalendar's range end is exclusive; subtract one day for display.
            const endInclusive = new Date(visibleRange.end.getTime() - 24 * 60 * 60 * 1000);
            const sameYear = start.getFullYear() === endInclusive.getFullYear();
            const sameMonth = sameYear && start.getMonth() === endInclusive.getMonth();
            const startStr = start.toLocaleDateString('en-US', sameMonth
                ? { month: 'short', day: 'numeric' }
                : { month: 'short', day: 'numeric' });
            const endStr = endInclusive.toLocaleDateString('en-US', sameYear
                ? { month: sameMonth ? undefined : 'short', day: 'numeric' }
                : { month: 'short', day: 'numeric', year: 'numeric' });
            const yearSuffix = sameYear ? `, ${endInclusive.getFullYear()}` : '';
            return `${startStr} – ${endStr}${yearSuffix}`;
        }
        const mid = new Date((visibleRange.start.getTime() + visibleRange.end.getTime()) / 2);
        return mid.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }, [visibleRange]);

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-4">
                {!loading && !error && (
                    <div className="mb-4 flex flex-col gap-2">
                        <div className="flex items-center gap-3">
                            <div className="flex gap-1 bg-slate-200 p-1 shrink-0 w-fit">
                                <Link
                                    to="/"
                                    className={`px-3 py-1 text-sm transition ${viewMode === 'explorer' ? 'bg-white text-slate-900 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    Explorer
                                </Link>
                                <Link
                                    to="/calendar"
                                    className={`px-3 py-1 text-sm transition ${viewMode === 'calendar' ? 'bg-white text-slate-900 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    Calendar
                                </Link>
                            </div>
                            <div className="flex gap-1 bg-slate-200 p-1 shrink-0 w-fit">
                                <SavedEventsFab />
                                <button
                                    onClick={() => setShowSuggestModal(true)}
                                    className="px-3 py-1 text-sm transition bg-white text-slate-900 font-medium shadow-sm hover:bg-slate-50"
                                >
                                    <span className="sm:hidden">Submit</span>
                                    <span className="hidden sm:inline">Submit Event</span>
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {loading && (
                    <p className="text-center text-slate-400">Loading events…</p>
                )}
                {error && (
                    <p className="text-center text-red-500">Error: {error}</p>
                )}
                {!loading && !error && viewMode === 'explorer' && (
                    <div className="flex flex-col lg:flex-row gap-6 lg:items-start">
                        {/* Left column: filters + list */}
                        <div className="order-1 lg:order-1 lg:w-[350px] lg:shrink-0 flex flex-col gap-4 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6">
                            <DateRangePicker
                                startDate={startDate}
                                endDate={endDate}
                                onChange={handleDateRangeChange}
                            />
                            {tagGroups.length > 0 && (
                                <TagFilterPills
                                    tagGroups={tagGroups}
                                    activeTagIds={activeTagIds}
                                    onToggle={handleToggleTag}
                                    onClear={handleClearTags}
                                />
                            )}
                            {/* Event list: hidden on mobile until after map, fills remaining height on desktop */}
                            <div className="hidden lg:block lg:flex-1 lg:min-h-0 lg:overflow-hidden">
                                <EventListPanel
                                    events={filteredEvents}
                                    mapBounds={mapBounds}
                                    onEventClick={handleExplorerListEventClick}
                                    showPrices={showPrices}
                                    showPopularity={showPopularity}
                                    popularityThreshold={popularityThreshold}
                                    sortBy={sortBy}
                                    onSortChange={setSortBy}
                                    hoveredEventId={hoveredEventId}
                                    onEventHover={handleEventHover}
                                />
                            </div>
                        </div>
                        {/* Map: order-2 on mobile, right column on desktop */}
                        <div className="order-2 lg:order-2 h-[250px] lg:flex-1 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6">
                            <EventMap
                                events={filteredEvents}
                                onEventClick={handleExplorerMapEventClick}
                                onBoundsChange={handleBoundsChange}
                                hoveredEventId={hoveredEventId}
                                onEventHover={handleEventHover}
                                detailLinkSource="explorer-map"
                            />
                        </div>
                        {/* Event list on mobile: order-3, hidden on desktop */}
                        <div className="order-3 lg:hidden">
                            <EventListPanel
                                events={filteredEvents}
                                mapBounds={mapBounds}
                                onEventClick={handleExplorerListEventClick}
                                showPrices={showPrices}
                                showPopularity={showPopularity}
                                popularityThreshold={popularityThreshold}
                                sortBy={sortBy}
                                onSortChange={setSortBy}
                                hoveredEventId={hoveredEventId}
                                onEventHover={handleEventHover}
                            />
                        </div>
                    </div>
                )}
                {!loading && !error && viewMode === 'calendar' && (
                    <>
                        {/* Calendar toolbar: section toggles + month navigation */}
                        <div className="mb-4 flex items-center gap-4 flex-wrap">
                            <div className="flex gap-1 bg-slate-200 p-1 shrink-0">
                                <button
                                    className={`px-2.5 py-1 text-xs font-medium transition ${showCalendarGrid ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                    onClick={() => setShowCalendarGrid((v) => !v)}
                                >
                                    📅 Calendar
                                </button>
                                <button
                                    className={`px-2.5 py-1 text-xs font-medium transition ${showCalendarMap ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                    onClick={() => setShowCalendarMap((v) => !v)}
                                >
                                    📍 Map
                                </button>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="flex">
                                    <button className="px-2 py-1 text-sm border border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalPrev}>‹</button>
                                    <button className="px-2.5 py-1 text-sm border-y border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalToday}>today</button>
                                    <button className="px-2 py-1 text-sm border border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalNext}>›</button>
                                </div>
                                <h2 className="text-lg font-semibold text-slate-800">{calendarTitle}</h2>
                            </div>
                            {isMobileViewport && (
                                <div className="flex gap-1 bg-slate-200 p-1 shrink-0 sm:hidden">
                                    <button
                                        className={`px-2 py-1 text-xs font-medium transition ${mobileCalendarView === '3week' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        onClick={() => setMobileCalendarView('3week')}
                                        aria-pressed={mobileCalendarView === '3week'}
                                    >
                                        3 wk
                                    </button>
                                    <button
                                        className={`px-2 py-1 text-xs font-medium transition ${mobileCalendarView === 'month' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        onClick={() => setMobileCalendarView('month')}
                                        aria-pressed={mobileCalendarView === 'month'}
                                    >
                                        Month
                                    </button>
                                </div>
                            )}
                        </div>
                        {tagGroups.length > 0 && (
                            <div className="mb-4">
                                <TagFilterPills
                                    tagGroups={tagGroups}
                                    activeTagIds={activeTagIds}
                                    onToggle={handleToggleTag}
                                    onClear={handleClearTags}
                                />
                            </div>
                        )}
                        <div className="flex flex-col lg:flex-row gap-6">
                            {/* Calendar always mounted — CSS-hidden when toggled off */}
                            <div className={showCalendarGrid ? 'min-w-0 flex-1' : 'calendar-hide-grid h-0 overflow-hidden'}>
                                <Calendar
                                    ref={calendarRef}
                                    events={filteredEvents}
                                    sinceDate={sinceDate ?? undefined}
                                    onDatesChange={handleDatesChange}
                                    onEventClick={handleEventClick}
                                    hoveredEventId={hoveredEventId}
                                    onEventHover={handleEventHover}
                                    offMapEventIds={offMapEventIds}
                                    viewMode={calendarViewMode}
                                />
                            </div>
                            {showCalendarMap && (
                                <div className={showCalendarGrid
                                    ? 'h-[400px] lg:w-[420px] lg:shrink-0 lg:h-[calc(100vh-200px)] lg:sticky lg:top-6'
                                    : 'h-[70vh] w-full'
                                }>
                                    <EventMap
                                        key={String(showCalendarGrid)}
                                        events={calendarVisibleEvents}
                                        focusedEvent={selectedEvent}
                                        onEventClick={handleCalMapEventClick}
                                        onBoundsChange={handleCalBoundsChange}
                                        hoveredEventId={hoveredEventId}
                                        onEventHover={handleEventHover}
                                        detailLinkSource="calendar-map"
                                    />
                                </div>
                            )}
                            {!showCalendarGrid && !showCalendarMap && (
                                <p className="text-center text-slate-400 py-12 w-full">Enable Calendar or Map above to view events.</p>
                            )}
                        </div>
                    </>
                )}
            </main>

            {/* Overlay modal — calendar mode mobile only */}
            {selectedEvent && viewMode === 'calendar' && !isDesktop && (
                <EventModal
                    event={selectedEvent}
                    onClose={handleCloseModal}
                    onEdit={user?.is_admin ? handleEditEvent : undefined}
                    source={selectedEventSource ?? undefined}
                />
            )}

            {selectedEvent && viewMode === 'calendar' && isDesktop && (
                <EventAnchoredDetailPanel
                    event={selectedEvent}
                    anchorRect={selectedEventRect}
                    onClose={handleCloseModal}
                    onEdit={user?.is_admin ? handleEditEvent : undefined}
                    source={selectedEventSource ?? undefined}
                />
            )}

            <AdminEventDetailPanel
                eventId={editingEventId}
                onClose={handleCloseEdit}
            />
            {showSuggestModal && (
                <SuggestEventModal onClose={() => setShowSuggestModal(false)} />
            )}
        </div>
    );
}
