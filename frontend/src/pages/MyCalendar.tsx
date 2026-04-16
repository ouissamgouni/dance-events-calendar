import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchEventsByIds, exportIcs, exportXlsx } from '../api';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import EventListPanel from '../components/EventListPanel';
import EventMap from '../components/EventMap';
import type { MapBounds } from '../components/EventMap';
import EventModal from '../components/EventModal';
import type { CalendarEvent } from '../types';

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
    const { savedEventIds, savedCount, clearAll } = useSavedEvents();
    const { showPrices, showPopularity } = useFeatureFlags();
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
    const [sortBy, setSortBy] = useState<'date' | 'popularity'>('date');
    const [exporting, setExporting] = useState('');

    useEffect(() => {
        if (savedEventIds.length === 0) {
            setEvents([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        fetchEventsByIds(savedEventIds)
            .then(setEvents)
            .catch(() => setEvents([]))
            .finally(() => setLoading(false));
    }, [savedEventIds]);

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        setSelectedEvent(evt);
    }, []);

    const handleBoundsChange = useCallback((bounds: MapBounds) => {
        setMapBounds(bounds);
    }, []);

    const handleExportIcs = useCallback(async () => {
        if (savedEventIds.length === 0) return;
        setExporting('ics');
        try {
            const blob = await exportIcs(savedEventIds);
            downloadBlob(blob, 'my-salsa-events.ics');
        } catch { /* ignore */ }
        finally { setExporting(''); }
    }, [savedEventIds]);

    const handleExportXlsx = useCallback(async () => {
        if (savedEventIds.length === 0) return;
        setExporting('xlsx');
        try {
            const blob = await exportXlsx(savedEventIds);
            downloadBlob(blob, 'my-salsa-events.xlsx');
        } catch { /* ignore */ }
        finally { setExporting(''); }
    }, [savedEventIds]);

    // Memoize empty array for the no-events case to keep EventMap stable
    const stableEmptyEvents = useMemo(() => [] as CalendarEvent[], []);
    const mapEvents = events.length > 0 ? events : stableEmptyEvents;

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
                        {savedCount > 0 && (
                            <span className="ml-2 text-sm font-normal text-slate-500">
                                ({savedCount} event{savedCount !== 1 ? 's' : ''})
                            </span>
                        )}
                    </h1>
                    {savedCount > 0 && (
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
                                onClick={clearAll}
                                className="rounded-full bg-red-50 px-3 py-1 text-xs text-red-600 hover:bg-red-100 transition"
                            >
                                Clear all
                            </button>
                        </div>
                    )}
                </div>

                {loading && (
                    <p className="text-center text-slate-400 py-12">Loading saved events…</p>
                )}

                {!loading && savedCount === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-10 h-10 text-slate-300 mb-4">
                            <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                        </svg>
                        <p className="text-slate-600 text-lg font-medium">No events saved yet</p>
                        <p className="text-slate-400 text-sm mt-1">
                            Browse events and tap the save icon to build your personal calendar.
                        </p>
                        <Link to="/" className="mt-6 text-sm text-slate-600 hover:underline">
                            ← Browse events
                        </Link>
                    </div>
                )}

                {!loading && savedCount > 0 && (
                    <div className="flex flex-col lg:flex-row gap-6">
                        {/* Left: Event list */}
                        <div className="order-1 lg:order-1 lg:w-[350px] lg:shrink-0 flex flex-col gap-4">
                            <div className="hidden lg:block lg:h-[calc(100vh-220px)] lg:overflow-hidden">
                                <EventListPanel
                                    events={events}
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
                                events={events}
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
