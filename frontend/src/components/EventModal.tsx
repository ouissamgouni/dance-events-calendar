import type { CalendarEvent } from '../types';
import { parseLinks } from '../utils/parseLinks';
import { deriveLinkLabel } from '../utils/deriveLinkLabel';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import LocationBadge from './LocationBadge';

interface Props {
    event: CalendarEvent;
    onClose: () => void;
    onEdit?: (event: CalendarEvent) => void;
}

export default function EventModal({ event, onClose, onEdit }: Props) {
    const { showPrices, showPopularity } = useFeatureFlags();
    const fallbackLinks = parseLinks(event.description);
    const structuredLinks = event.links && event.links.length > 0 ? event.links : null;
    const start = new Date(event.start);
    const end = new Date(event.end);

    const formatDate = (d: Date) =>
        d.toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
        });

    const formatTime = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <div
                className="flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl max-h-[85vh]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between border-b border-slate-100 px-6 pt-5 pb-4">
                    <div>
                        <h2 className="text-lg font-bold text-slate-900 leading-snug">
                            {event.title}
                        </h2>
                        <p className="mt-1 text-xs text-slate-500">
                            🗓 {event.all_day
                                ? formatDate(start)
                                : `${formatDate(start)} · ${formatTime(start)} – ${formatTime(end)}`}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="ml-4 shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {/* Scrollable body */}
                <div className="modal-scroll overflow-y-auto overscroll-contain px-6 py-4 space-y-4 text-sm text-slate-600">
                    <div className="flex items-center gap-2">
                        <LocationBadge location={event.location} latitude={event.latitude} longitude={event.longitude} />
                        {showPrices && event.price_is_free && (
                            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                                Free
                            </span>
                        )}
                        {showPrices && !event.price_is_free && event.price_min != null && event.price_currency && (
                            <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                                {event.price_max != null && event.price_max !== event.price_min
                                    ? `${event.price_currency} ${event.price_min}\u2013${event.price_max}`
                                    : `${event.price_currency} ${event.price_min}`}
                            </span>
                        )}
                        {showPopularity && event.view_count > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                                {event.view_count >= 10 ? '\uD83D\uDD25' : '\uD83D\uDC41'} {event.view_count} view{event.view_count !== 1 ? 's' : ''}
                            </span>
                        )}
                    </div>

                    {event.location && (
                        <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-slate-700">
                            <span className="mt-0.5">📍</span>
                            <span>{event.location}</span>
                        </p>
                    )}

                    {event.description && (
                        <div className="whitespace-pre-line leading-relaxed text-slate-600">
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

                {/* Footer — share + edit */}
                <div className="border-t border-slate-100 px-6 py-3 flex items-center justify-between">
                    <button
                        onClick={() => {
                            const url = `${window.location.origin}/event/${event.event_id}`;
                            navigator.clipboard.writeText(url).catch(() => { });
                        }}
                        className="text-xs text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full px-3 py-1 transition"
                    >
                        🔗 Copy link
                    </button>
                    {onEdit && (
                        <button
                            onClick={() => onEdit(event)}
                            className="text-sm font-medium text-blue-600 hover:text-blue-700 transition"
                        >
                            ✏️ Edit event
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
