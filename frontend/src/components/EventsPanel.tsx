import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent } from '../types';
import type {
    EventFilterParams,
    EventFilterOptionsResponse,
    FilterOption,
    PaginatedEventsResponse,
} from '../api';
import {
    fetchAdminEvents,
    fetchEventFilterOptions,
    reviewEvent,
    bulkReviewEvents,
    bulkRetryGeocoding,
    bulkAssignTags,
} from '../api';
import LocationBadge from './LocationBadge';
import EventEditModal from './EventEditModal';

export type EventsPanelPreset = 'all' | 'pending' | 'ungeolocated';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    preset: EventsPanelPreset;
}

const PAGE_SIZE = 25;

const PRESET_FILTERS: Record<EventsPanelPreset, Partial<EventFilterParams>> = {
    all: {},
    pending: { review_status: 'pending', future_only: true },
    ungeolocated: { ungeolocated: true, future_only: true },
};

const PRESET_TITLES: Record<EventsPanelPreset, string> = {
    all: 'Events',
    pending: 'Pending Review',
    ungeolocated: 'Ungeolocated Events',
};

export default function EventsPanel({ isOpen, onClose, preset }: Props) {
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [filterOptions, setFilterOptions] = useState<EventFilterOptionsResponse | null>(null);
    const [selectedCalendar, setSelectedCalendar] = useState<string>('');
    const [selectedReviewStatus, setSelectedReviewStatus] = useState<string>('');
    const [selectedGeoStatus, setSelectedGeoStatus] = useState<string>('');
    const [selectedTagIds, setSelectedTagIds] = useState<string>('');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState('');
    const searchTimer = useRef<ReturnType<typeof setTimeout>>();

    // Build filter params from current state
    const buildParams = useCallback(
        (pageOverride?: number): EventFilterParams => {
            const presetFilters = PRESET_FILTERS[preset];
            return {
                limit: PAGE_SIZE,
                offset: (pageOverride ?? page) * PAGE_SIZE,
                search: debouncedSearch || undefined,
                review_status: selectedReviewStatus || presetFilters.review_status || undefined,
                calendar_id: selectedCalendar || undefined,
                tag_ids: selectedTagIds || undefined,
                ungeolocated: selectedGeoStatus === 'ungeolocated' || presetFilters.ungeolocated || undefined,
                future_only: presetFilters.future_only || undefined,
            };
        },
        [preset, page, debouncedSearch, selectedReviewStatus, selectedCalendar, selectedTagIds, selectedGeoStatus],
    );

    // Load events
    const loadEvents = useCallback(
        async (pageOverride?: number) => {
            setLoading(true);
            try {
                const params = buildParams(pageOverride);
                const [eventsRes, optionsRes] = await Promise.all([
                    fetchAdminEvents(params),
                    fetchEventFilterOptions(params),
                ]);
                setEvents(eventsRes.items);
                setTotal(eventsRes.total);
                setFilterOptions(optionsRes);
            } catch {
                setMessage('Failed to load events.');
            } finally {
                setLoading(false);
            }
        },
        [buildParams],
    );

    // Reset state when panel opens or preset changes
    useEffect(() => {
        if (isOpen) {
            setPage(0);
            setSearch('');
            setDebouncedSearch('');
            setSelectedCalendar('');
            setSelectedReviewStatus('');
            setSelectedGeoStatus('');
            setSelectedTagIds('');
            setSelectedIds(new Set());
            setMessage('');
            setEditingEvent(null);
        }
    }, [isOpen, preset]);

    // Fetch when filters/page change
    useEffect(() => {
        if (isOpen) {
            loadEvents();
        }
    }, [isOpen, loadEvents]);

    // Debounce search
    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => {
            setDebouncedSearch(search);
            setPage(0);
        }, 300);
        return () => {
            if (searchTimer.current) clearTimeout(searchTimer.current);
        };
    }, [search]);

    const totalPages = Math.ceil(total / PAGE_SIZE);

    const handleSelectAll = () => {
        if (selectedIds.size === events.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(events.map((e) => e.event_id)));
        }
    };

    const handleToggleSelect = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleBulkReview = async () => {
        if (selectedIds.size === 0) return;
        setBusy('bulk-review');
        try {
            const result = await bulkReviewEvents([...selectedIds]);
            setMessage(`Marked ${result.marked_reviewed} event(s) as reviewed.`);
            setSelectedIds(new Set());
            loadEvents();
        } catch {
            setMessage('Failed to bulk review.');
        } finally {
            setBusy('');
        }
    };

    const handleBulkRetryGeo = async () => {
        if (selectedIds.size === 0) return;
        setBusy('bulk-geo');
        try {
            const result = await bulkRetryGeocoding([...selectedIds]);
            setMessage(`Geocoded: ${result.geocoded}, Failed: ${result.failed}`);
            setSelectedIds(new Set());
            loadEvents();
        } catch {
            setMessage('Failed to retry geocoding.');
        } finally {
            setBusy('');
        }
    };

    const handleSingleReview = async (eventId: string) => {
        try {
            await reviewEvent(eventId);
            loadEvents();
        } catch {
            setMessage('Failed to review event.');
        }
    };

    const handleEventSaved = (updated: CalendarEvent) => {
        setEvents((prev) => prev.map((e) => (e.event_id === updated.event_id ? updated : e)));
        setEditingEvent(null);
    };

    const formatDate = (iso: string) => {
        const d = new Date(iso);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    };

    return (
        <>
            {isOpen && (
                <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
            )}

            <div
                className={`fixed top-0 right-0 h-full w-[720px] max-w-full bg-white shadow-lg border-l border-gray-200 z-50 transform transition-transform duration-200 ease-in-out flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50 shrink-0">
                    <h2 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">
                        {PRESET_TITLES[preset]}
                        {!loading && (
                            <span className="ml-2 text-[10px] font-normal text-gray-400 normal-case">
                                {total} event{total !== 1 ? 's' : ''}
                            </span>
                        )}
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {/* Filter Bar */}
                <div className="px-4 py-2 border-b border-gray-100 space-y-2 shrink-0">
                    {/* Search */}
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search title, description, location…"
                        className="w-full border border-gray-200 px-2.5 py-1.5 text-[11px] text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />

                    {/* Filter Chips */}
                    {filterOptions && (
                        <div className="flex flex-wrap gap-1.5">
                            {/* Calendar filter */}
                            {filterOptions.calendars.length > 1 && (
                                <select
                                    value={selectedCalendar}
                                    onChange={(e) => { setSelectedCalendar(e.target.value); setPage(0); }}
                                    className="border border-gray-200 text-[10px] text-gray-600 px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                                >
                                    <option value="">All calendars</option>
                                    {filterOptions.calendars.map((c) => (
                                        <option key={c.value} value={c.value}>
                                            {c.label} ({c.count})
                                        </option>
                                    ))}
                                </select>
                            )}

                            {/* Review status chips */}
                            {preset === 'all' && filterOptions.review_statuses.map((rs) => (
                                <button
                                    key={rs.value}
                                    onClick={() => {
                                        setSelectedReviewStatus((prev) => (prev === rs.value ? '' : rs.value));
                                        setPage(0);
                                    }}
                                    className={`text-[10px] font-medium px-2 py-0.5 border transition ${selectedReviewStatus === rs.value
                                        ? 'bg-blue-50 border-blue-300 text-blue-700'
                                        : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                                        }`}
                                >
                                    {rs.label} ({rs.count})
                                </button>
                            ))}

                            {/* Geo status chips */}
                            {preset === 'all' && filterOptions.geo_statuses.map((gs) => (
                                <button
                                    key={gs.value}
                                    onClick={() => {
                                        setSelectedGeoStatus((prev) => (prev === gs.value ? '' : gs.value));
                                        setPage(0);
                                    }}
                                    className={`text-[10px] font-medium px-2 py-0.5 border transition ${selectedGeoStatus === gs.value
                                        ? 'bg-blue-50 border-blue-300 text-blue-700'
                                        : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                                        }`}
                                >
                                    {gs.label} ({gs.count})
                                </button>
                            ))}

                            {/* Tag chips */}
                            {filterOptions.tags.length > 0 && (
                                <select
                                    value={selectedTagIds}
                                    onChange={(e) => { setSelectedTagIds(e.target.value); setPage(0); }}
                                    className="border border-gray-200 text-[10px] text-gray-600 px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                                >
                                    <option value="">All tags</option>
                                    {filterOptions.tags.map((t) => (
                                        <option key={t.value} value={t.value}>
                                            {t.label} ({t.count})
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>
                    )}
                </div>

                {/* Message */}
                {message && (
                    <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 text-[11px] text-blue-700 shrink-0 flex items-center justify-between">
                        <span>{message}</span>
                        <button onClick={() => setMessage('')} className="text-blue-400 hover:text-blue-600 ml-2">✕</button>
                    </div>
                )}

                {/* Table */}
                <div className="flex-1 overflow-y-auto">
                    {loading && events.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-gray-400">
                            <p className="text-xs">Loading…</p>
                        </div>
                    ) : events.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-gray-400">
                            <p className="text-xs">No events match your filters.</p>
                        </div>
                    ) : (
                        <table className="w-full text-[11px]">
                            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
                                <tr>
                                    <th className="w-8 px-2 py-2 text-left">
                                        <input
                                            type="checkbox"
                                            checked={events.length > 0 && selectedIds.size === events.length}
                                            onChange={handleSelectAll}
                                            className="h-3 w-3"
                                        />
                                    </th>
                                    <th className="px-2 py-2 text-left font-semibold text-gray-600 uppercase tracking-wide">Title</th>
                                    <th className="px-2 py-2 text-left font-semibold text-gray-600 uppercase tracking-wide w-24">Date</th>
                                    <th className="px-2 py-2 text-left font-semibold text-gray-600 uppercase tracking-wide w-20">Status</th>
                                    <th className="px-2 py-2 text-center font-semibold text-gray-600 uppercase tracking-wide w-10">Geo</th>
                                    <th className="px-2 py-2 text-left font-semibold text-gray-600 uppercase tracking-wide w-24">Tags</th>
                                    <th className="px-2 py-2 w-16"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {events.map((event) => (
                                    <tr
                                        key={event.event_id}
                                        className={`hover:bg-gray-50/50 transition cursor-pointer ${selectedIds.has(event.event_id) ? 'bg-blue-50/30' : ''}`}
                                        onClick={() => setEditingEvent(event)}
                                    >
                                        <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.has(event.event_id)}
                                                onChange={() => handleToggleSelect(event.event_id)}
                                                className="h-3 w-3"
                                            />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                {event.color && (
                                                    <span
                                                        className="w-1.5 h-1.5 rounded-full shrink-0"
                                                        style={{ backgroundColor: event.color }}
                                                    />
                                                )}
                                                <span className="truncate font-medium text-gray-800 max-w-[260px]">
                                                    {event.title}
                                                </span>
                                            </div>
                                            {event.location && (
                                                <p className="text-[10px] text-gray-400 truncate max-w-[260px] mt-0.5">
                                                    {event.location}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">
                                            {formatDate(event.start)}
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <span
                                                className={`inline-block text-[10px] font-medium px-1.5 py-0.5 ${event.review_status === 'pending'
                                                    ? 'bg-amber-50 text-amber-700'
                                                    : 'bg-emerald-50 text-emerald-700'
                                                    }`}
                                            >
                                                {event.review_status ?? 'reviewed'}
                                            </span>
                                        </td>
                                        <td className="px-2 py-1.5 text-center">
                                            <LocationBadge
                                                location={event.location}
                                                latitude={event.latitude}
                                                longitude={event.longitude}
                                                size="sm"
                                            />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <div className="flex flex-wrap gap-0.5">
                                                {event.tags.slice(0, 2).map((t) => (
                                                    <span
                                                        key={t.id}
                                                        className="text-[9px] px-1 py-0 bg-gray-100 text-gray-500 truncate max-w-[60px]"
                                                    >
                                                        {t.label}
                                                    </span>
                                                ))}
                                                {event.tags.length > 2 && (
                                                    <span className="text-[9px] text-gray-400">+{event.tags.length - 2}</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                                            {event.review_status === 'pending' && (
                                                <button
                                                    onClick={() => handleSingleReview(event.event_id)}
                                                    className="text-[10px] text-blue-600 hover:text-blue-800 font-medium"
                                                    title="Mark reviewed"
                                                >
                                                    ✓
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-between px-4 py-2 border-t border-gray-200 bg-gray-50 shrink-0">
                        <span className="text-[10px] text-gray-400">
                            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                        </span>
                        <div className="flex gap-1">
                            <button
                                onClick={() => setPage((p) => Math.max(0, p - 1))}
                                disabled={page === 0}
                                className="text-[10px] px-2 py-1 border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-40 transition"
                            >
                                ← Prev
                            </button>
                            <button
                                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                                disabled={page >= totalPages - 1}
                                className="text-[10px] px-2 py-1 border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-40 transition"
                            >
                                Next →
                            </button>
                        </div>
                    </div>
                )}

                {/* Bulk Action Bar */}
                {selectedIds.size > 0 && (
                    <div className="flex items-center gap-2 px-4 py-2 border-t border-blue-200 bg-blue-50 shrink-0">
                        <span className="text-[10px] font-medium text-blue-700">
                            {selectedIds.size} selected
                        </span>
                        <div className="flex-1" />
                        <button
                            onClick={handleBulkReview}
                            disabled={!!busy}
                            className="text-[10px] font-medium px-2 py-1 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition"
                        >
                            {busy === 'bulk-review' ? 'Reviewing…' : 'Mark Reviewed'}
                        </button>
                        <button
                            onClick={handleBulkRetryGeo}
                            disabled={!!busy}
                            className="text-[10px] font-medium px-2 py-1 bg-gray-700 text-white hover:bg-gray-800 disabled:opacity-50 transition"
                        >
                            {busy === 'bulk-geo' ? 'Retrying…' : 'Retry Geocoding'}
                        </button>
                        <button
                            onClick={() => setSelectedIds(new Set())}
                            className="text-[10px] text-gray-500 hover:text-gray-700 px-1"
                        >
                            Clear
                        </button>
                    </div>
                )}
            </div>

            {/* Edit Modal */}
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
