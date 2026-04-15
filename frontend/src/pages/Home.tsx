import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import type { CalendarEvent, CalendarSetting } from '../types';
import { fetchEvents, fetchCalendars, fetchSettings, updateEvent } from '../api';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type FullCalendar from '@fullcalendar/react';
import Calendar from '../components/Calendar';
import EventMap from '../components/EventMap';
import type { MapBounds } from '../components/EventMap';
import EventModal from '../components/EventModal';
import EventEditModal from '../components/EventEditModal';
import SuggestEventModal from '../components/SuggestEventModal';
import CalendarFilterPills from '../components/CalendarFilterPills';
import DateRangePicker from '../components/DateRangePicker';
import EventListPanel from '../components/EventListPanel';

type ViewMode = 'explorer' | 'calendar';

function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

export default function Home() {
    const { user } = useAuth();
    const { showPrices, showPopularity } = useFeatureFlags();
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [sinceDate, setSinceDate] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
    const [showSuggestModal, setShowSuggestModal] = useState(false);
    const [calendars, setCalendars] = useState<CalendarSetting[]>([]);
    const [activeCalendarIds, setActiveCalendarIds] = useState<Set<string> | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('explorer');
    const [sortBy, setSortBy] = useState<'date' | 'popularity'>('date');

    // Calendar view section visibility
    const [showCalendarGrid, setShowCalendarGrid] = useState(true);
    const [showCalendarMap, setShowCalendarMap] = useState(true);

    // Explorer state
    const today = formatDate(new Date());
    const defaultEndDate = new Date();
    defaultEndDate.setMonth(defaultEndDate.getMonth() + 1);
    const [startDate, setStartDate] = useState(today);
    const [endDate, setEndDate] = useState(formatDate(defaultEndDate));
    const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);

    // Calendar state
    const [visibleRange, setVisibleRange] = useState<{ start: Date; end: Date } | null>(null);

    // Fetch events when date range changes (explorer mode) or on mount
    useEffect(() => {
        setLoading(true);
        const params = viewMode === 'explorer' ? { startDate, endDate } : undefined;
        Promise.all([fetchEvents(params), fetchSettings(), fetchCalendars()])
            .then(([evts, settings, cals]) => {
                setEvents(evts);
                setSinceDate(settings.since_date);
                setCalendars(cals);
                setActiveCalendarIds((prev) => {
                    if (prev !== null) return prev;
                    return new Set(cals.map((c) => c.calendar_id));
                });
            })
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, [viewMode, startDate, endDate]);

    const handleDateRangeChange = useCallback((start: string, end: string) => {
        setStartDate(start);
        setEndDate(end);
    }, []);

    const handleToggleCalendar = useCallback((calendarId: string) => {
        setActiveCalendarIds((prev) => {
            const next = new Set(prev);
            if (next.has(calendarId)) {
                next.delete(calendarId);
            } else {
                next.add(calendarId);
            }
            return next;
        });
    }, []);

    const filteredEvents = useMemo(() => {
        if (!activeCalendarIds || activeCalendarIds.size === calendars.length) return events;
        return events.filter((e) => activeCalendarIds.has(e.calendar_id));
    }, [events, activeCalendarIds, calendars.length]);

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

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        setSelectedEvent(evt);
    }, []);

    const handleCloseModal = useCallback(() => {
        setSelectedEvent(null);
    }, []);

    const handleEditEvent = useCallback((evt: CalendarEvent) => {
        setSelectedEvent(null);
        setEditingEvent(evt);
    }, []);

    const handleEventSaved = useCallback((updated: CalendarEvent) => {
        setEvents((prev) => prev.map((e) => (e.event_id === updated.event_id ? updated : e)));
        setEditingEvent(null);
    }, []);

    const handleBoundsChange = useCallback((bounds: MapBounds) => {
        setMapBounds(bounds);
    }, []);

    // Calendar ref + navigation (FC is always mounted in calendar mode)
    const calendarRef = useRef<FullCalendar>(null);

    const handleCalPrev = useCallback(() => calendarRef.current?.getApi().prev(), []);
    const handleCalNext = useCallback(() => calendarRef.current?.getApi().next(), []);
    const handleCalToday = useCallback(() => calendarRef.current?.getApi().today(), []);

    const calendarTitle = useMemo(() => {
        if (!visibleRange) return '';
        const mid = new Date((visibleRange.start.getTime() + visibleRange.end.getTime()) / 2);
        return mid.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }, [visibleRange]);

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-4">
                {!loading && !error && (
                    <div className="mb-4 flex flex-wrap items-center gap-3">
                        <div className="flex gap-1 bg-slate-200 p-1 shrink-0">
                            <button
                                className={`px-3 py-1 text-sm transition ${viewMode === 'explorer' ? 'bg-white text-slate-900 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                onClick={() => setViewMode('explorer')}
                            >
                                Explorer
                            </button>
                            <button
                                className={`px-3 py-1 text-sm transition ${viewMode === 'calendar' ? 'bg-white text-slate-900 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                onClick={() => setViewMode('calendar')}
                            >
                                Calendar
                            </button>
                        </div>
                        {calendars.length > 1 && activeCalendarIds && (
                            <CalendarFilterPills
                                calendars={calendars}
                                activeIds={activeCalendarIds}
                                onToggle={handleToggleCalendar}
                            />
                        )}
                        <button
                            onClick={() => setShowSuggestModal(true)}
                            className="ml-auto rounded-full bg-rose-600 px-4 py-1.5 text-sm font-medium text-white shadow hover:bg-rose-700 transition"
                        >
                            Suggest an Event
                        </button>
                    </div>
                )}
                {loading && (
                    <p className="text-center text-slate-400">Loading events…</p>
                )}
                {error && (
                    <p className="text-center text-red-500">Error: {error}</p>
                )}
                {!loading && !error && viewMode === 'explorer' && (
                    <div className="flex flex-col lg:flex-row gap-6">
                        {/* Filters: order-1 on mobile, part of left column on desktop */}
                        <div className="order-1 lg:order-1 lg:w-[350px] lg:shrink-0 flex flex-col gap-4">
                            <DateRangePicker
                                startDate={startDate}
                                endDate={endDate}
                                onChange={handleDateRangeChange}
                            />
                            {/* Event list: hidden on mobile until after map, visible on desktop */}
                            <div className="hidden lg:block lg:h-[calc(100vh-320px)] lg:overflow-hidden">
                                <EventListPanel
                                    events={filteredEvents}
                                    mapBounds={mapBounds}
                                    onEventClick={handleEventClick}
                                    showPrices={showPrices}
                                    showPopularity={showPopularity}
                                    sortBy={sortBy}
                                    onSortChange={setSortBy}
                                />
                            </div>
                        </div>
                        {/* Map: order-2 on mobile, right column on desktop */}
                        <div className="order-2 lg:order-2 h-[400px] lg:flex-1 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6">
                            <EventMap
                                events={filteredEvents}
                                focusedEvent={selectedEvent}
                                onEventClick={handleEventClick}
                                onBoundsChange={handleBoundsChange}
                            />
                        </div>
                        {/* Event list on mobile: order-3, hidden on desktop (already shown in left column) */}
                        <div className="order-3 lg:hidden">
                            <EventListPanel
                                events={filteredEvents}
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
                        </div>
                        <div className="flex flex-col lg:flex-row gap-6">
                            {/* Calendar always mounted — CSS-hidden when toggled off */}
                            <div className={showCalendarGrid ? 'min-w-0 flex-1' : 'calendar-hide-grid h-0 overflow-hidden'}>
                                <Calendar
                                    ref={calendarRef}
                                    events={filteredEvents}
                                    sinceDate={sinceDate ?? undefined}
                                    onDatesChange={handleDatesChange}
                                    onEventClick={handleEventClick}
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
                                        onEventClick={handleEventClick}
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

            {selectedEvent && (
                <EventModal
                    event={selectedEvent}
                    onClose={handleCloseModal}
                    onEdit={user ? handleEditEvent : undefined}
                />
            )}

            {editingEvent && (
                <EventEditModal
                    event={editingEvent}
                    onClose={() => setEditingEvent(null)}
                    onSaved={handleEventSaved}
                />
            )}
            {showSuggestModal && (
                <SuggestEventModal onClose={() => setShowSuggestModal(false)} />
            )}
        </div>
    );
}
