import { useState } from 'react';
import type { CalendarEvent, TagGroup } from '../types';
import { parseLinks } from '../utils/parseLinks';
import { deriveLinkLabel } from '../utils/deriveLinkLabel';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { trackLink } from '../utils/tracking';
import { fetchTagGroups } from '../api';
import LocationBadge from './LocationBadge';
import SaveEventButton from './SaveEventButton';
import TagBadges from './TagBadges';
import SuggestTagsButton from './SuggestTagsButton';

interface Props {
    event: CalendarEvent;
    /** Show suggest-tags and edit buttons */
    showActions?: boolean;
    onEdit?: (event: CalendarEvent) => void;
    /** Compact layout for inline / side-panel rendering */
    compact?: boolean;
}

export default function EventDetailContent({ event, showActions = true, onEdit, compact = false }: Props) {
    const { showPrices, showPopularity } = useFeatureFlags();
    const [showSuggestTags, setShowSuggestTags] = useState(false);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);

    const fallbackLinks = parseLinks(event.description);
    const structuredLinks = event.links && event.links.length > 0 ? event.links : null;
    const hasVisibleBadge =
        (showPrices && (event.price_is_free || (event.price_min != null && event.price_currency))) ||
        (showPopularity && event.view_count > 0);
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
        <div className="space-y-4">
            {/* Date + badges */}
            <div>
                <p className={`text-slate-500 ${compact ? 'text-xs' : 'text-sm'}`}>
                    🗓 {event.all_day
                        ? formatDate(start)
                        : `${formatDate(start)} · ${formatTime(start)} – ${formatTime(end)}`}
                </p>
                {hasVisibleBadge && (
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
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
                )}
            </div>

            {/* Location */}
            {event.location && (
                <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    <span className="mt-0.5 flex items-center gap-1">
                        📍
                        <LocationBadge size="sm" location={event.location} latitude={event.latitude} longitude={event.longitude} />
                    </span>
                    <span>{event.location}</span>
                </p>
            )}

            {/* Tags */}
            {event.tags?.length > 0 && (
                <TagBadges tags={event.tags} />
            )}

            {/* Description */}
            {event.description && (
                <div className={`whitespace-pre-line leading-relaxed text-slate-600 ${compact ? 'text-xs' : 'text-sm'}`}>
                    {event.description}
                </div>
            )}

            {/* Links */}
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
                                onClick={() => trackLink(event.event_id, link.url)}
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
                            onClick={() => trackLink(event.event_id, url)}
                            className="block truncate text-rose-600 hover:text-rose-700 hover:underline text-xs"
                        >
                            {url}
                        </a>
                    ))}
                </div>
            )}

            {/* Suggest tags panel */}
            {showSuggestTags && (
                <div className="border-t border-slate-100 pt-2">
                    <SuggestTagsButton
                        eventId={event.event_id}
                        tagGroups={tagGroups}
                        existingTagIds={new Set(event.tags?.map((t) => t.id) ?? [])}
                        deviceId={localStorage.getItem('device_id') || 'anonymous'}
                        onClose={() => setShowSuggestTags(false)}
                    />
                </div>
            )}

            {/* Action bar */}
            {showActions && (
                <div className="border-t border-slate-100 pt-3 flex items-center gap-2 flex-wrap">
                    <SaveEventButton eventId={event.event_id} appearance="pill" />
                    <button
                        onClick={() => {
                            const url = `${window.location.origin}/event/${event.event_id}`;
                            navigator.clipboard.writeText(url).catch(() => { });
                        }}
                        className="text-xs text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full px-3 py-1 transition"
                    >
                        🔗 Copy link
                    </button>
                    <button
                        onClick={() => {
                            if (!tagGroups.length) fetchTagGroups().then(setTagGroups).catch(() => { });
                            setShowSuggestTags(!showSuggestTags);
                        }}
                        className="text-xs text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full px-3 py-1 transition"
                    >
                        Suggest {' '}
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="inline h-3.5 w-3.5 align-[-1px]">
                            <path fillRule="evenodd" d="M2 4.75A2.75 2.75 0 0 1 4.75 2h4.379a2.75 2.75 0 0 1 1.944.805l5.122 5.122a2.75 2.75 0 0 1 0 3.889l-4.38 4.379a2.75 2.75 0 0 1-3.888 0L2.805 11.073A2.75 2.75 0 0 1 2 9.129V4.75Zm4.5 1.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                        </svg>
                    </button>
                    {onEdit && (
                        <button
                            onClick={() => onEdit(event)}
                            className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:text-slate-900"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                                <path d="m5.433 13.917.664-2.657a2 2 0 0 1 .503-.896l6.657-6.657a2.121 2.121 0 1 1 3 3l-6.657 6.657a2 2 0 0 1-.896.503l-2.657.664a.75.75 0 0 1-.914-.914Z" />
                                <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v11.5C2 17.216 2.784 18 3.75 18h11.5A1.75 1.75 0 0 0 17 16.25V12a.75.75 0 0 0-1.5 0v4.25a.25.25 0 0 1-.25.25H3.75a.25.25 0 0 1-.25-.25V4.75a.25.25 0 0 1 .25-.25H8a.75.75 0 0 0 0-1.5H3.75Z" />
                            </svg>
                            Edit
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
