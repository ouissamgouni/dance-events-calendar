import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent } from '../types';
import type {
    EventFilterParams,
    EventFilterOptionsResponse,
} from '../api';
import {
    fetchAdminEvents,
    fetchEventFilterOptions,
    fetchAdminEventIds,
    fetchAdminTagGroups,
    reviewEvent,
    bulkReviewEvents,
    bulkRetryGeocoding,
    bulkAssignTags,
    runTagSuggestionsBulk,
    adminBulkEngagement,
    fetchAdminUsers,
} from '../api';
import type { AdminTagGroup, AdminBulkEngagementKind, AdminBulkEngagementAudience, AdminUserRow } from '../api';
import LocationBadge from './LocationBadge';
import AdminEventDetailPanel from './AdminEventDetailPanel';
import { useAdminPrefs } from '../context/AdminPrefsContext';

export type EventsPanelPreset = 'all' | 'pending' | 'ungeolocated';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    preset: EventsPanelPreset;
    initialCalendarId?: string;
}

const PAGE_SIZE = 25;

const PRESET_FILTERS: Record<EventsPanelPreset, Partial<EventFilterParams>> = {
    all: {},
    pending: { review_status: 'pending' },
    ungeolocated: { ungeolocated: true },
};

const PRESET_TITLES: Record<EventsPanelPreset, string> = {
    all: 'Events',
    pending: 'Pending Review',
    ungeolocated: 'Ungeolocated Events',
};

export default function EventsPanel({ isOpen, onClose, preset, initialCalendarId }: Props) {
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
    const [allMatchingSelected, setAllMatchingSelected] = useState(false);
    const [adminDetailEventId, setAdminDetailEventId] = useState<string | null>(null);
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState('');
    const [tagGroups, setTagGroups] = useState<AdminTagGroup[]>([]);
    const [bulkTagPickerOpen, setBulkTagPickerOpen] = useState(false);
    const [bulkTagIds, setBulkTagIds] = useState<number[]>([]);
    // Curate-to-lists dialog state. Targets are admin-managed users.
    const [curatePickerOpen, setCuratePickerOpen] = useState(false);
    const [managedUsers, setManagedUsers] = useState<AdminUserRow[]>([]);
    const [selectedCurateHandles, setSelectedCurateHandles] = useState<Set<string>>(new Set());
    const [curateKind, setCurateKind] = useState<AdminBulkEngagementKind>('save');
    const [curateAudience, setCurateAudience] = useState<AdminBulkEngagementAudience | ''>('');
    const [selectedVisibility, setSelectedVisibility] = useState<'hidden' | 'blocked' | ''>('');
    // Hide past events by default; toggle (here or in the admin header) to
    // include them. Mirrors the global admin pref so all panels stay in sync.
    const { includePast, setIncludePast } = useAdminPrefs();
    const hidePast = !includePast;
    const setHidePast = (value: boolean | ((prev: boolean) => boolean)) => {
        const next = typeof value === 'function' ? (value as (p: boolean) => boolean)(hidePast) : value;
        setIncludePast(!next);
    };
    const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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
                include_past: !hidePast || undefined,
                visibility: selectedVisibility || undefined,
            };
        },
        [preset, page, debouncedSearch, selectedReviewStatus, selectedCalendar, selectedTagIds, selectedGeoStatus, hidePast, selectedVisibility],
    );

    // Load events
    const loadEvents = useCallback(
        async (pageOverride?: number) => {
            setLoading(true);
            try {
                const params = buildParams(pageOverride);
                // Fetch filter options without calendar_id so the calendar dropdown
                // always shows all calendars regardless of the current selection.
                const { calendar_id: _calId, ...optionParams } = params;
                const [eventsRes, optionsRes] = await Promise.all([
                    fetchAdminEvents(params),
                    fetchEventFilterOptions(optionParams),
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
            setSelectedCalendar(initialCalendarId ?? '');
            setSelectedReviewStatus('');
            setSelectedGeoStatus('');
            setSelectedTagIds('');
            setSelectedIds(new Set());
            setAllMatchingSelected(false);
            setMessage('');
            setAdminDetailEventId(null);
            setBulkTagPickerOpen(false);
            setBulkTagIds([]);
            setSelectedCurateHandles(new Set());
            // Don't reset hidePast here — it's now driven by the global
            // admin pref so reopening the panel respects the user's choice.
        }
    }, [isOpen, preset, initialCalendarId]);

    // Load tag groups once for the bulk tag picker
    useEffect(() => {
        if (isOpen && tagGroups.length === 0) {
            fetchAdminTagGroups().then(setTagGroups).catch(() => { });
        }
    }, [isOpen]);  // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!isOpen) return;
        fetchAdminUsers({ managedOnly: true, limit: 200 })
            .then((res) => setManagedUsers(res.items.filter((u) => u.handle && !u.deleted_at && !u.is_admin)))
            .catch(() => setManagedUsers([]));
    }, [isOpen]);

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
            setAllMatchingSelected(false);
        } else {
            setSelectedIds(new Set(events.map((e) => e.event_id)));
            setAllMatchingSelected(false);
        }
    };

    const handleSelectAllMatching = async () => {
        setBusy('select-all');
        try {
            const params = buildParams(0);
            // Remove pagination for the IDs fetch
            const { limit: _l, offset: _o, ...filterParams } = params;
            const result = await fetchAdminEventIds(filterParams);
            setSelectedIds(new Set(result.ids));
            setAllMatchingSelected(true);
        } catch {
            setMessage('Failed to select all matching events.');
        } finally {
            setBusy('');
        }
    };

    const handleToggleBulkTag = (tagId: number) => {
        setBulkTagIds((prev) =>
            prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
        );
    };

    const handleToggleCurateHandle = (handle: string) => {
        setSelectedCurateHandles((prev) => {
            const next = new Set(prev);
            if (next.has(handle)) next.delete(handle);
            else next.add(handle);
            return next;
        });
    };

    const handleBulkAssignTags = async () => {
        if (selectedIds.size === 0 || bulkTagIds.length === 0) return;
        setBusy('bulk-tags');
        try {
            const result = await bulkAssignTags([...selectedIds], bulkTagIds);
            setMessage(`Assigned ${result.assigned} tag assignment(s) across ${selectedIds.size} event(s).`);
            setSelectedIds(new Set());
            setAllMatchingSelected(false);
            setBulkTagPickerOpen(false);
            setBulkTagIds([]);
            loadEvents();
        } catch {
            setMessage('Failed to assign tags.');
        } finally {
            setBusy('');
        }
    };

    const handleBulkCurate = async () => {
        if (selectedIds.size === 0) return;
        const handles = [...selectedCurateHandles];
        if (handles.length === 0) {
            setMessage('Select one or more admin-managed users.');
            return;
        }
        setBusy('bulk-curate');
        try {
            const res = await adminBulkEngagement(
                handles,
                [...selectedIds],
                curateKind,
                'add',
                { audience: curateAudience || undefined },
            );
            const skippedItems = res.items.filter((item) => item.status.startsWith('skipped'));
            const skipped = skippedItems.length > 0 ? ` (${skippedItems.length} skipped)` : '';
            const skippedDetails = skippedItems.slice(0, 3).map((item) => {
                const detail = item.detail ? `: ${item.detail}` : '';
                return `@${item.handle} / ${item.event_id}${detail}`;
            });
            const skippedText = skippedDetails.length > 0
                ? ` Skipped: ${skippedDetails.join('; ')}${skippedItems.length > 3 ? `; +${skippedItems.length - 3} more` : ''}.`
                : '';
            setMessage(
                `Curated ${res.changed_count} ${curateKind} entry(ies) across ${handles.length} account(s)${skipped}.${skippedText}`,
            );
            setCuratePickerOpen(false);
            setSelectedCurateHandles(new Set());
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to curate.');
        } finally {
            setBusy('');
        }
    };

    const handleToggleSelect = (id: string) => {
        setAllMatchingSelected(false);
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

    const handleBulkSuggestTags = async () => {
        if (selectedIds.size === 0) return;
        // Bulk endpoint caps at 200; clamp client-side for clearer UX.
        const ids = [...selectedIds].slice(0, 200);
        const truncated = selectedIds.size > 200;
        setBusy('bulk-suggest-tags');
        try {
            const result = await runTagSuggestionsBulk(ids);
            const trailer = truncated ? ' (capped at 200)' : '';
            setMessage(
                `auto tag suggestions: generated ${result.generated} across ` +
                `${result.events_processed} events${trailer}. Review in the ` +
                `Tag Suggestions panel.`,
            );
            setSelectedIds(new Set());
        } catch {
            setMessage('Failed to generate tag suggestions.');
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
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => loadEvents()}
                            className={`text-gray-400 hover:text-gray-600 p-1 transition-transform ${loading ? 'animate-spin' : ''}`}
                            title="Refresh"
                            aria-label="Refresh"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="23 4 23 10 17 10" />
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                            </svg>
                        </button>
                        <h2 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">
                            {PRESET_TITLES[preset]}
                            {!loading && (
                                <span className="ml-2 text-[10px] font-normal text-gray-400 normal-case">
                                    {total} event{total !== 1 ? 's' : ''}
                                </span>
                            )}
                        </h2>
                    </div>
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
                            {filterOptions.calendars.length > 0 && (
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

                            {/* Hide past events toggle */}
                            <button
                                onClick={() => { setHidePast((v) => !v); setPage(0); }}
                                className={`text-[10px] font-medium px-2 py-0.5 border transition ${hidePast
                                    ? 'bg-blue-50 border-blue-300 text-blue-700'
                                    : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                                    }`}
                                title={hidePast ? 'Currently hiding past events. Click to include them.' : 'Currently including past events. Click to hide.'}
                            >
                                {hidePast ? 'Hide past' : 'Include past'}
                            </button>

                            {/* Visibility pills */}
                            {(['hidden', 'blocked'] as const).map((v) => (
                                <button
                                    key={v}
                                    onClick={() => { setSelectedVisibility((prev) => (prev === v ? '' : v)); setPage(0); }}
                                    className={`text-[10px] font-medium px-2 py-0.5 border transition ${selectedVisibility === v
                                        ? v === 'hidden'
                                            ? 'bg-amber-100 border-amber-400 text-amber-800'
                                            : 'bg-slate-200 border-slate-400 text-slate-800'
                                        : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                                        }`}
                                >
                                    {v.charAt(0).toUpperCase() + v.slice(1)}
                                </button>
                            ))}
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
                                        className={`hover:bg-opacity-80 transition cursor-pointer ${event.is_blocked
                                            ? 'bg-slate-100 hover:bg-slate-200/70'
                                            : event.is_hidden
                                                ? 'bg-amber-50 hover:bg-amber-100/70'
                                                : selectedIds.has(event.event_id)
                                                    ? 'bg-blue-50/30'
                                                    : 'hover:bg-gray-50/50'
                                            }`}
                                        onClick={() => setAdminDetailEventId(event.event_id)}
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
                                            <div className="flex flex-wrap gap-1">
                                                <span
                                                    className={`inline-block text-[10px] font-medium px-1.5 py-0.5 ${event.review_status === 'pending'
                                                        ? 'bg-amber-50 text-amber-700'
                                                        : 'bg-emerald-50 text-emerald-700'
                                                        }`}
                                                >
                                                    {event.review_status ?? 'reviewed'}
                                                </span>
                                                {event.is_blocked && (
                                                    <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 bg-slate-200 text-slate-700">Blocked</span>
                                                )}
                                                {event.is_hidden && !event.is_blocked && (
                                                    <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 bg-amber-100 text-amber-700">Hidden</span>
                                                )}
                                            </div>
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

                {/* Select-all-matching banner */}
                {selectedIds.size === events.length && events.length === PAGE_SIZE && total > PAGE_SIZE && !allMatchingSelected && (
                    <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 border-t border-amber-200 text-[10px] text-amber-800 shrink-0">
                        <span>All {events.length} on this page selected.</span>
                        <button
                            onClick={handleSelectAllMatching}
                            disabled={busy === 'select-all'}
                            className="font-semibold underline hover:no-underline disabled:opacity-50"
                        >
                            {busy === 'select-all' ? 'Selecting…' : `Select all ${total} matching events`}
                        </button>
                    </div>
                )}
                {allMatchingSelected && (
                    <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 border-t border-amber-200 text-[10px] text-amber-800 shrink-0">
                        <span>All {selectedIds.size} matching events selected.</span>
                        <button
                            onClick={() => { setSelectedIds(new Set(events.map((e) => e.event_id))); setAllMatchingSelected(false); }}
                            className="font-semibold underline hover:no-underline"
                        >
                            Revert to page selection
                        </button>
                    </div>
                )}

                {/* Bulk Tag Picker */}
                {bulkTagPickerOpen && (
                    <div className="px-4 py-2.5 border-t border-blue-200 bg-white shrink-0">
                        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide mb-2">Assign tags to {selectedIds.size} event(s)</p>
                        <div className="flex flex-wrap gap-1 mb-2">
                            {tagGroups.filter((g) => g.enabled).map((group) =>
                                group.tags.filter((t) => t.enabled).map((tag) => (
                                    <button
                                        key={tag.id}
                                        onClick={() => handleToggleBulkTag(tag.id)}
                                        className={`text-[10px] px-2 py-0.5 border transition ${bulkTagIds.includes(tag.id)
                                            ? 'bg-blue-600 border-blue-600 text-white'
                                            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                                            }`}
                                        style={bulkTagIds.includes(tag.id) && tag.color ? { backgroundColor: tag.color, borderColor: tag.color } : {}}
                                    >
                                        {tag.label}
                                    </button>
                                ))
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={handleBulkAssignTags}
                                disabled={bulkTagIds.length === 0 || !!busy}
                                className="text-[10px] font-medium px-2.5 py-1 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition"
                            >
                                {busy === 'bulk-tags' ? 'Applying…' : `Apply ${bulkTagIds.length > 0 ? `(${bulkTagIds.length})` : ''}`}
                            </button>
                            <button
                                onClick={() => { setBulkTagPickerOpen(false); setBulkTagIds([]); }}
                                className="text-[10px] text-gray-500 hover:text-gray-700"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Curate-to-Lists Picker */}
                {curatePickerOpen && (
                    <div className="px-4 py-2.5 border-t border-indigo-200 bg-white shrink-0 space-y-2">
                        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">
                            Curate {selectedIds.size} event(s) to admin-managed lists
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                            <label className="text-[10px] text-gray-600 flex items-center gap-1">
                                List:
                                <select
                                    value={curateKind}
                                    onChange={(e) => setCurateKind(e.target.value as AdminBulkEngagementKind)}
                                    className="text-[10px] border border-gray-300 px-1 py-0.5"
                                >
                                    <option value="save">Saved</option>
                                    <option value="going">Going</option>
                                </select>
                            </label>
                            <label className="text-[10px] text-gray-600 flex items-center gap-1">
                                Audience:
                                <select
                                    value={curateAudience}
                                    onChange={(e) => setCurateAudience(e.target.value as AdminBulkEngagementAudience | '')}
                                    className="text-[10px] border border-gray-300 px-1 py-0.5"
                                    title="Per-row audience. Defaults to each target's profile setting when blank."
                                >
                                    <option value="">target default</option>
                                    <option value="public">public</option>
                                    <option value="friends">friends</option>
                                    <option value="private">private</option>
                                </select>
                            </label>
                        </div>
                        <div className="max-h-28 overflow-y-auto border border-gray-200 bg-white">
                            {managedUsers.length === 0 ? (
                                <p className="px-2 py-2 text-[10px] text-gray-500">No admin-managed users yet.</p>
                            ) : managedUsers.map((u) => {
                                const handle = u.handle ?? '';
                                const active = selectedCurateHandles.has(handle);
                                return (
                                    <label key={u.user_id} className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-2 py-1.5 last:border-b-0 hover:bg-gray-50">
                                        <input
                                            type="checkbox"
                                            checked={active}
                                            onChange={() => handleToggleCurateHandle(handle)}
                                            className="h-3 w-3"
                                        />
                                        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-700">
                                            @{handle}{u.managed_label ? ` - ${u.managed_label}` : ''}
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                        <p className="text-[10px] text-gray-500">
                            Only admin-managed users are listed. No notifications are fanned out.
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={handleBulkCurate}
                                disabled={!!busy || selectedCurateHandles.size === 0}
                                className="text-[10px] font-medium px-2.5 py-1 bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 transition"
                            >
                                {busy === 'bulk-curate' ? 'Curating…' : 'Apply'}
                            </button>
                            <button
                                onClick={() => { setCuratePickerOpen(false); setSelectedCurateHandles(new Set()); }}
                                className="text-[10px] text-gray-500 hover:text-gray-700"
                            >
                                Cancel
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
                            onClick={() => { setBulkTagPickerOpen((o) => !o); setBulkTagIds([]); }}
                            disabled={!!busy}
                            className="text-[10px] font-medium px-2 py-1 bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition"
                        >
                            Assign Tags
                        </button>
                        <button
                            onClick={() => { setCuratePickerOpen((o) => !o); }}
                            disabled={!!busy}
                            className="text-[10px] font-medium px-2 py-1 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition"
                            title="Add to Saved/Going on admin-managed curator accounts"
                        >
                            Curate to Lists
                        </button>
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
                            onClick={handleBulkSuggestTags}
                            disabled={!!busy}
                            className="text-[10px] font-medium px-2 py-1 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition"
                            title="Run the heuristic tag suggester on the selected events. Suggestions land as pending — review in the Tag Suggestions panel."
                        >
                            {busy === 'bulk-suggest-tags' ? 'Suggesting…' : 'Auto-suggest Tags'}
                        </button>
                        <button
                            onClick={() => { setSelectedIds(new Set()); setAllMatchingSelected(false); setBulkTagPickerOpen(false); }}
                            className="text-[10px] text-gray-500 hover:text-gray-700 px-1"
                        >
                            Clear
                        </button>
                    </div>
                )}
            </div>

            {/* Admin event detail side panel */}
            <AdminEventDetailPanel
                eventId={adminDetailEventId}
                onClose={() => setAdminDetailEventId(null)}
                onEventUpdated={() => loadEvents()}
            />
        </>
    );
}
