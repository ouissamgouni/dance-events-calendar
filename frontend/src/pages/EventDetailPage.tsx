import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { fetchEvent, trackEventView } from '../api';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { parseLinks } from '../utils/parseLinks';
import { deriveLinkLabel } from '../utils/deriveLinkLabel';
import LocationBadge from '../components/LocationBadge';
import type { CalendarEvent } from '../types';

export default function EventDetailPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(true);
    const { showPrices, showPopularity } = useFeatureFlags();

    useEffect(() => {
        if (!eventId) return;
        fetchEvent(eventId)
            .then((e) => {
                setEvent(e);
                trackEventView(eventId);
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
    const end = new Date(event.end);
    const fallbackLinks = parseLinks(event.description);
    const structuredLinks = event.links && event.links.length > 0 ? event.links : null;

    const formatDate = (d: Date) =>
        d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const formatTime = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

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

    const handleCopyLink = async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
        } catch {
            // fallback ignored
        }
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
                            <p className="mt-2 text-sm text-slate-500">
                                🗓 {event.all_day
                                    ? formatDate(start)
                                    : `${formatDate(start)} · ${formatTime(start)} – ${formatTime(end)}`}
                            </p>
                        </div>

                        {/* Body */}
                        <div className="px-6 py-5 space-y-4">
                            <div className="flex items-center gap-2 flex-wrap">
                                <LocationBadge location={event.location} latitude={event.latitude} longitude={event.longitude} />
                                {showPrices && event.price_is_free && (
                                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                                        Free
                                    </span>
                                )}
                                {showPrices && !event.price_is_free && event.price_min != null && event.price_currency && (
                                    <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                                        {event.price_max != null && event.price_max !== event.price_min
                                            ? `${event.price_currency} ${event.price_min}–${event.price_max}`
                                            : `${event.price_currency} ${event.price_min}`}
                                    </span>
                                )}
                                {showPopularity && event.view_count > 0 && (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                                        {event.view_count >= 10 ? '🔥' : '👁'} {event.view_count} view{event.view_count !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>

                            {event.location && (
                                <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                                    <span className="mt-0.5">📍</span>
                                    <span>{event.location}</span>
                                </p>
                            )}

                            {event.description && (
                                <div className="whitespace-pre-line leading-relaxed text-sm text-slate-600">
                                    {event.description}
                                </div>
                            )}

                            {structuredLinks ? (
                                <div className="space-y-1.5 border-t border-slate-100 pt-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Links</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {structuredLinks.map((link, i) => (
                                            <a
                                                key={i}
                                                href={link.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-rose-600 hover:bg-rose-100 transition"
                                            >
                                                🔗 {link.label || deriveLinkLabel(link.url)}
                                            </a>
                                        ))}
                                    </div>
                                </div>
                            ) : fallbackLinks.length > 0 && (
                                <div className="space-y-1.5 border-t border-slate-100 pt-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Links</p>
                                    {fallbackLinks.map((url) => (
                                        <a
                                            key={url}
                                            href={url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="block truncate text-rose-600 hover:text-rose-700 hover:underline text-xs"
                                        >
                                            {url}
                                        </a>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Share bar */}
                        <div className="border-t border-slate-100 px-6 py-3 flex items-center gap-3">
                            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Share</span>
                            <button
                                onClick={handleCopyLink}
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
        </>
    );
}
