import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import L from 'leaflet';
import { fetchEvent } from '../api';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAuth } from '../context/AuthContext';
import { trackView } from '../utils/tracking';
import EventDetailContent from '../components/EventDetailContent';
import EventEditModal from '../components/EventEditModal';
import type { CalendarEvent } from '../types';

function makePin(color: string): L.DivIcon {
    return L.divIcon({
        className: '',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        html: `<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="14" r="11" fill="${color}" stroke="white" stroke-width="2.5" />
            <circle cx="14" cy="14" r="4" fill="white" opacity="0.9" />
        </svg>`,
    });
}

export default function EventDetailPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(true);
    const { isSaved, toggleSave } = useSavedEvents();
    const { user } = useAuth();

    useEffect(() => {
        if (!eventId) return;
        fetchEvent(eventId)
            .then((e) => {
                setEvent(e);
                trackView(eventId, 'direct');
            })
            .catch(() => setError(true))
            .finally(() => setLoading(false));
    }, [eventId]);

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-slate-50">
                <p className="text-slate-500">Loading event…</p>
            </div>
        );
    }

    if (error || !event) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 gap-4">
                <p className="text-slate-600 text-lg">Event not found</p>
                <Link to="/" className="text-rose-600 hover:underline text-sm">← Back to calendar</Link>
            </div>
        );
    }

    const start = new Date(event.start);
    const formatDate = (d: Date) =>
        d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const formatTime = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const end = new Date(event.end);

    const pageTitle = `${event.title} — ${formatDate(start)}`;
    const pageDescription = [
        event.location && `📍 ${event.location}`,
        !event.all_day && `🕐 ${formatTime(start)} – ${formatTime(end)}`,
        event.price_is_free && '🎉 Free',
        event.description?.slice(0, 120),
    ].filter(Boolean).join(' · ');

    // Schema.org JSON-LD for DanceEvent
    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'DanceEvent',
        name: event.title,
        startDate: event.start,
        endDate: event.end,
        description: event.description || undefined,
        ...(event.location && {
            location: {
                '@type': 'Place',
                name: event.location,
                ...(event.latitude != null && event.longitude != null && {
                    geo: {
                        '@type': 'GeoCoordinates',
                        latitude: event.latitude,
                        longitude: event.longitude,
                    },
                }),
            },
        }),
        ...(event.price_is_free
            ? { isAccessibleForFree: true }
            : event.price_min != null && event.price_currency && {
                offers: {
                    '@type': 'Offer',
                    price: event.price_min,
                    ...(event.price_max != null && event.price_max !== event.price_min && {
                        highPrice: event.price_max,
                    }),
                    priceCurrency: event.price_currency,
                    availability: 'https://schema.org/InStock',
                },
            }),
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    };

    const shareUrl = window.location.href;

    const handleEventSaved = (updated: CalendarEvent) => {
        setEvent(updated);
        setEditingEvent(null);
    };

    return (
        <>
            <Helmet>
                <title>{pageTitle}</title>
                <meta name="description" content={pageDescription} />
                <meta property="og:title" content={event.title} />
                <meta property="og:description" content={pageDescription} />
                <meta property="og:type" content="website" />
                <meta property="og:url" content={shareUrl} />
                <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
            </Helmet>

            <div className="min-h-screen bg-slate-50">
                <div className="mx-auto max-w-2xl px-4 py-8">
                    <Link to="/" className="text-sm text-rose-600 hover:underline mb-6 inline-block">
                        ← Back to calendar
                    </Link>

                    <article className="bg-white rounded-2xl shadow-lg overflow-hidden">
                        {/* Header */}
                        <div className="px-6 pt-6 pb-4 border-b border-slate-100">
                            <h1 className="text-2xl font-bold text-slate-900 leading-tight">
                                {event.title}
                            </h1>
                        </div>

                        {/* Body — shared content */}
                        <div className="px-6 py-5">
                            <EventDetailContent
                                event={event}
                                onEdit={user ? (evt) => setEditingEvent(evt) : undefined}
                            />
                        </div>

                        {/* Mini map */}
                        {event.latitude != null && event.longitude != null && (
                            <div className="h-48 border-t border-slate-100">
                                <MapContainer
                                    center={[event.latitude, event.longitude]}
                                    zoom={14}
                                    className="h-full w-full"
                                    scrollWheelZoom={false}
                                    dragging={false}
                                    zoomControl={false}
                                    attributionControl={false}
                                >
                                    <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                                    <Marker
                                        position={[event.latitude, event.longitude]}
                                        icon={makePin(event.color ?? '#e11d48')}
                                    />
                                </MapContainer>
                            </div>
                        )}

                        {/* Share bar */}
                        <div className="border-t border-slate-100 px-6 py-3 flex items-center gap-3">
                            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Share</span>
                            <button
                                onClick={() => toggleSave(event.event_id)}
                                className={`text-xs rounded-full px-3 py-1 transition flex items-center gap-1 ${isSaved(event.event_id) ? 'text-slate-800 bg-slate-200 hover:bg-slate-300' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'}`}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                                    <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                                </svg>
                                {isSaved(event.event_id) ? 'Saved' : 'Save'}
                            </button>
                            <button
                                onClick={() => navigator.clipboard.writeText(shareUrl).catch(() => { })}
                                className="text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-full px-3 py-1 transition"
                            >
                                📋 Copy link
                            </button>
                            <a
                                href={`https://wa.me/?text=${encodeURIComponent(event.title + ' — ' + shareUrl)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-full px-3 py-1 transition"
                            >
                                💬 WhatsApp
                            </a>
                        </div>
                    </article>
                </div>
            </div>
            {editingEvent && (
                <EventEditModal
                    event={editingEvent}
                    onClose={() => setEditingEvent(null)}
                    onSaved={handleEventSaved}
                />
            )}
        </>
    );
}
