import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchSharedCalendar } from '../api';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { trackView } from '../utils/tracking';
import EventListPanel from '../components/EventListPanel';
import EventMap from '../components/EventMap';
import type { MapBounds } from '../components/EventMap';
import EventModal from '../components/EventModal';
import type { CalendarEvent } from '../types';

export default function SharedCalendarPage() {
    const { token } = useParams<{ token: string }>();
    const { showPrices, showPopularity } = useFeatureFlags();

    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
    const [sortBy, setSortBy] = useState<'date' | 'popularity'>('date');

    useEffect(() => {
        if (!token) return;
        setLoading(true);
        setNotFound(false);
        fetchSharedCalendar(token)
            .then(setEvents)
            .catch((err: Error) => {
                if (err.message === 'not_found') setNotFound(true);
                setEvents([]);
            })
            .finally(() => setLoading(false));
    }, [token]);

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        trackView(evt.event_id, 'direct');
        setSelectedEvent(evt);
    }, []);

    const handleBoundsChange = useCallback((bounds: MapBounds) => {
        setMapBounds(bounds);
    }, []);

    const stableEmptyEvents = useMemo(() => [] as CalendarEvent[], []);
    const mapEvents = events.length > 0 ? events : stableEmptyEvents;

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-4">
                {/* Header */}
                <div className="mb-4 flex flex-wrap items-center gap-3">
                    <Link to="/" className="text-sm text-rose-600 hover:underline shrink-0">
                        ← Browse events
                    </Link>
                    <h1 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-slate-700">
                            <path fillRule="evenodd" d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.243Z" clipRule="evenodd" />
                        </svg>
                        Shared Calendar
                        {!loading && !notFound && (
                            <span className="ml-2 text-sm font-normal text-slate-500">
                                ({events.length} event{events.length !== 1 ? 's' : ''})
                            </span>
                        )}
                    </h1>
                    {!loading && !notFound && events.length > 0 && (
                        <div className="ml-auto">
                            <Link
                                to="/my-calendar"
                                className="rounded-full bg-rose-50 px-3 py-1 text-xs text-rose-600 hover:bg-rose-100 transition"
                            >
                                My Calendar →
                            </Link>
                        </div>
                    )}
                </div>

                {/* Shared-link banner */}
                {!loading && !notFound && (
                    <div className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-500">
                        This is a shared calendar. Save individual events to add them to{' '}
                        <Link to="/my-calendar" className="text-rose-600 hover:underline">
                            your own calendar
                        </Link>
                        .
                    </div>
                )}

                {loading && (
                    <p className="text-center text-slate-400 py-12">Loading shared calendar…</p>
                )}

                {!loading && notFound && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <p className="text-slate-600 text-lg font-medium">Share link not found</p>
                        <p className="text-slate-400 text-sm mt-1">
                            This link may be invalid or the calendar may have been removed.
                        </p>
                        <Link to="/" className="mt-6 text-sm text-slate-600 hover:underline">
                            ← Browse events
                        </Link>
                    </div>
                )}

                {!loading && !notFound && events.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-10 h-10 text-slate-300 mb-4">
                            <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                        </svg>
                        <p className="text-slate-600 text-lg font-medium">No events saved yet</p>
                        <p className="text-slate-400 text-sm mt-1">
                            The owner of this calendar hasn't saved any events yet.
                        </p>
                    </div>
                )}

                {!loading && !notFound && events.length > 0 && (
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
                        {/* Mobile-only list below map */}
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
            </main>

            {selectedEvent && (
                <EventModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
            )}
        </div>
    );
}
