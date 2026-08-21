import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent, SeriesGroup, DuplicateGroup } from '../types';
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
    flagEventsAsDuplicates,
    keepDuplicateEvent,
    dismissDuplicateGroup,
    groupEventsAsSeries,
    addEventsToSeries,
    approveSeriesGroup,
    dismissSeriesGroup,
    splitSeriesMember,
    fetchSeriesGroups,
} from '../api';
import type { AdminTagGroup, AdminBulkEngagementKind, AdminBulkEngagementAudience, AdminUserRow } from '../api';
import LocationBadge from './LocationBadge';
import AdminEventDetailPanel from './AdminEventDetailPanel';
import TagsPicker from './TagsPicker';
import SeriesGroupCard from './SeriesGroupCard';
import DuplicateGroupCard from './DuplicateGroupCard';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';

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
    // Inline result cards for series grouping / duplicate flagging. They stay
    // visible until the admin resolves (approve/keep) or dismisses them.
    const [seriesGroupResult, setSeriesGroupResult] = useState<SeriesGroup | null>(null);
    const [duplicateGroupResult, setDuplicateGroupResult] = useState<DuplicateGroup | null>(null);
    const [inlineActing, setInlineActing] = useState(false);
    // Add-to-existing-series picker state.
    const [addSeriesPickerOpen, setAddSeriesPickerOpen] = useState(false);
    const [seriesSearch, setSeriesSearch] = useState('');
    const [seriesSearchResults, setSeriesSearchResults] = useState<SeriesGroup[]>([]);
    const [seriesSearchLoading, setSeriesSearchLoading] = useState(false);
    // Inline "group as series" title entry (prompts are disallowed in this app).
    const [seriesTitlePickerOpen, setSeriesTitlePickerOpen] = useState(false);
    const [seriesTitleDraft, setSeriesTitleDraft] = useState('');
    // Curate-to-lists dialog state. Targets are admin-managed users.
    const [curatePickerOpen, setCuratePickerOpen] = useState(false);
    const [managedUsers, setManagedUsers] = useState<AdminUserRow[]>([]);
    const [selectedCurateHandles, setSelectedCurateHandles] = useState<Set<string>>(new Set());
    const [curateKind, setCurateKind] = useState<AdminBulkEngagementKind>('save');
    const [curateAudience, setCurateAudience] = useState<AdminBulkEngagementAudience | ''>('');
    const [selectedVisibility, setSelectedVisibility] = useState<'hidden' | 'blocked' | ''>('');
    // Hide past events by default; toggle to include them. Local to this panel
    // so the Events and Pending Review panels filter independently.
    const [hidePast, setHidePast] = useState(true);
    const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const seriesSearchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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
            setHidePast(true);
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

    // Auto-suggest existing series as the admin types (>= 3 chars), debounced.
    useEffect(() => {
        if (!addSeriesPickerOpen) return;
        const term = seriesSearch.trim();
        if (term.length < 3) return;
        if (seriesSearchTimer.current) clearTimeout(seriesSearchTimer.current);
        seriesSearchTimer.current = setTimeout(() => {
            setSeriesSearchLoading(true);
            fetchSeriesGroups('all', { q: term, limit: 20 })
                .then((res) => setSeriesSearchResults(res.items))
                .catch(() => setSeriesSearchResults([]))
                .finally(() => setSeriesSearchLoading(false));
        }, 250);
        return () => {
            if (seriesSearchTimer.current) clearTimeout(seriesSearchTimer.current);
        };
    }, [seriesSearch, addSeriesPickerOpen]);

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

    const handleBulkFlagDuplicates = async () => {
        if (selectedIds.size < 2) return;
        setBusy('bulk-flag-duplicates');
        try {
            const group = await flagEventsAsDuplicates([...selectedIds]);
            setDuplicateGroupResult(group);
            setSeriesGroupResult(null);
            setMessage(`Flagged ${selectedIds.size} event(s) as duplicates.`);
            setSelectedIds(new Set());
            setAllMatchingSelected(false);
            notifyAdminDataChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to flag events as duplicates.');
        } finally {
            setBusy('');
        }
    };

    const handleKeepDuplicate = async (keepEventId: string) => {
        if (!duplicateGroupResult) return;
        setInlineActing(true);
        try {
            await keepDuplicateEvent(duplicateGroupResult.id, keepEventId);
            setDuplicateGroupResult(null);
            notifyAdminDataChanged();
            loadEvents();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to keep event.');
        } finally {
            setInlineActing(false);
        }
    };

    const handleDismissDuplicate = async () => {
        if (!duplicateGroupResult) return;
        setInlineActing(true);
        try {
            await dismissDuplicateGroup(duplicateGroupResult.id);
            setDuplicateGroupResult(null);
            notifyAdminDataChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to dismiss group.');
        } finally {
            setInlineActing(false);
        }
    };

    const handleGroupAsSeries = async () => {
        if (selectedIds.size < 2 || selectedIds.size > 20) return;
        const firstTitle = events.find((e) => selectedIds.has(e.event_id))?.title ?? '';
        setSeriesTitleDraft(firstTitle);
        setSeriesTitlePickerOpen(true);
    };

    const handleConfirmGroupAsSeries = async () => {
        if (selectedIds.size < 2 || selectedIds.size > 20) return;
        setBusy('bulk-series');
        try {
            const group = await groupEventsAsSeries([...selectedIds], seriesTitleDraft.trim() || undefined);
            setSeriesGroupResult(group);
            setDuplicateGroupResult(null);
            setSeriesTitlePickerOpen(false);
            setSeriesTitleDraft('');
            setMessage(`Grouped ${group.events.length} event(s) as a series.`);
            setSelectedIds(new Set());
            setAllMatchingSelected(false);
            notifyAdminDataChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to group events as series.');
        } finally {
            setBusy('');
        }
    };

    const handleApproveInlineSeries = async () => {
        if (!seriesGroupResult) return;
        setInlineActing(true);
        try {
            await approveSeriesGroup(seriesGroupResult.id);
            setSeriesGroupResult(null);
            notifyAdminDataChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to approve series.');
        } finally {
            setInlineActing(false);
        }
    };

    const handleDismissInlineSeries = async () => {
        if (!seriesGroupResult) return;
        setInlineActing(true);
        try {
            await dismissSeriesGroup(seriesGroupResult.id);
            setSeriesGroupResult(null);
            notifyAdminDataChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to dismiss series.');
        } finally {
            setInlineActing(false);
        }
    };

    const handleSplitInlineSeries = async (eventId: string) => {
        if (!seriesGroupResult) return;
        setInlineActing(true);
        try {
            const res = await splitSeriesMember(seriesGroupResult.id, eventId);
            setSeriesGroupResult(res.dissolved ? null : res.series);
            notifyAdminDataChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to remove event from series.');
        } finally {
            setInlineActing(false);
        }
    };

    const handleAddToSeries = async (seriesId: number) => {
        if (selectedIds.size === 0) return;
        setBusy('bulk-add-series');
        try {
            const group = await addEventsToSeries(seriesId, [...selectedIds]);
            setSeriesGroupResult(group);
            setDuplicateGroupResult(null);
            setAddSeriesPickerOpen(false);
            setSeriesSearch('');
            setSeriesSearchResults([]);
            setMessage(`Added ${selectedIds.size} event(s) to "${group.canonical_title}".`);
            setSelectedIds(new Set());
            setAllMatchingSelected(false);
            notifyAdminDataChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to add events to series.');
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
                className={`fixed top-0 right-0 h-full w-[720px] max-w-full bg-surface shadow-lg border-l border-line z-50 transform transition-transform duration-200 ease-in-out flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-canvas shrink-0">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => loadEvents()}
                            className={`text-muted hover:text-ink-soft p-1 transition-transform ${loading ? 'animate-spin' : ''}`}
                            title="Refresh"
                            aria-label="Refresh"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="23 4 23 10 17 10" />
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                            </svg>
                        </button>
                        <h2 className="text-xs font-semibold text-ink uppercase tracking-wide">
                            {PRESET_TITLES[preset]}
                            {!loading && (
                                <span className="ml-2 text-[10px] font-normal text-muted normal-case">
                                    {total} event{total !== 1 ? 's' : ''}
                                </span>
                            )}
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-muted hover:text-ink-soft text-sm leading-none p-1"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {/* Filter Bar */}
                <div className="px-4 py-2 border-b border-card-line space-y-2 shrink-0">
                    {/* Search */}
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search title, description, location…"
                        className="w-full border border-line px-2.5 py-1.5 text-[11px] text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                    />

                    {/* Filter Chips */}
                    {filterOptions && (
                        <div className="flex flex-wrap gap-1.5">
                            {/* Calendar filter */}
                            {filterOptions.calendars.length > 0 && (
                                <select
                                    value={selectedCalendar}
                                    onChange={(e) => { setSelectedCalendar(e.target.value); setPage(0); }}
                                    className="border border-line text-[10px] text-ink-soft px-1.5 py-1 bg-surface focus:outline-none focus:ring-1 focus:ring-action"
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
                                        ? 'bg-blue-50 border-blue-300 text-action'
                                        : 'bg-surface border-line text-ink-soft hover:bg-canvas'
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
                                        ? 'bg-blue-50 border-blue-300 text-action'
                                        : 'bg-surface border-line text-ink-soft hover:bg-canvas'
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
                                    className="border border-line text-[10px] text-ink-soft px-1.5 py-1 bg-surface focus:outline-none focus:ring-1 focus:ring-action"
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
                                className={`text-[10px] font-medium px-2 py-0.5 border transition ${!hidePast
                                    ? 'bg-blue-50 border-blue-300 text-action'
                                    : 'bg-surface border-line text-ink-soft hover:bg-canvas'
                                    }`}
                                title={hidePast ? 'Past events hidden. Click to show them.' : 'Including past events. Click to hide them.'}
                            >
                                {hidePast ? 'Show past' : 'Hide past'}
                            </button>

                            {/* Visibility pills */}
                            {(['hidden', 'blocked'] as const).map((v) => (
                                <button
                                    key={v}
                                    onClick={() => { setSelectedVisibility((prev) => (prev === v ? '' : v)); setPage(0); }}
                                    className={`text-[10px] font-medium px-2 py-0.5 border transition ${selectedVisibility === v
                                        ? v === 'hidden'
                                            ? 'bg-amber-100 border-amber-400 text-amber-800'
                                            : 'bg-slate-200 border-line text-ink'
                                        : 'bg-surface border-line text-ink-soft hover:bg-canvas'
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
                    <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 text-[11px] text-action shrink-0 flex items-center justify-between">
                        <span>{message}</span>
                        <button onClick={() => setMessage('')} className="text-blue-400 hover:text-action ml-2">✕</button>
                    </div>
                )}

                {/* Table */}
                <div className="flex-1 overflow-y-auto">
                    {loading && events.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-muted">
                            <p className="text-xs">Loading…</p>
                        </div>
                    ) : events.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-muted">
                            <p className="text-xs">No events match your filters.</p>
                        </div>
                    ) : (
                        <table className="w-full text-[11px]">
                            <thead className="sticky top-0 bg-canvas border-b border-line z-10">
                                <tr>
                                    <th className="w-8 px-2 py-2 text-left">
                                        <input
                                            type="checkbox"
                                            checked={events.length > 0 && selectedIds.size === events.length}
                                            onChange={handleSelectAll}
                                            className="h-3 w-3"
                                        />
                                    </th>
                                    <th className="px-2 py-2 text-left font-semibold text-ink-soft uppercase tracking-wide">Title</th>
                                    <th className="px-2 py-2 text-left font-semibold text-ink-soft uppercase tracking-wide w-24">Date</th>
                                    <th className="px-2 py-2 text-left font-semibold text-ink-soft uppercase tracking-wide w-20">Status</th>
                                    <th className="px-2 py-2 text-center font-semibold text-ink-soft uppercase tracking-wide w-10">Geo</th>
                                    <th className="px-2 py-2 text-left font-semibold text-ink-soft uppercase tracking-wide w-24">Tags</th>
                                    <th className="px-2 py-2 w-16"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {events.map((event) => (
                                    <tr
                                        key={event.event_id}
                                        className={`hover:bg-opacity-80 transition cursor-pointer ${event.is_blocked
                                            ? 'bg-slate-100 hover:bg-canvas/70'
                                            : event.is_hidden
                                                ? 'bg-amber-50 hover:bg-amber-100/70'
                                                : selectedIds.has(event.event_id)
                                                    ? 'bg-blue-50/30'
                                                    : 'hover:bg-canvas/50'
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
                                                <span className="truncate font-medium text-ink max-w-[260px]">
                                                    {event.title}
                                                </span>
                                            </div>
                                            {event.location && (
                                                <p className="text-[10px] text-muted truncate max-w-[260px] mt-0.5">
                                                    {event.location}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-2 py-1.5 text-ink-soft whitespace-nowrap">
                                            {formatDate(event.start)}
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <div className="flex flex-wrap gap-1">
                                                <span
                                                    className={`inline-block text-[10px] font-medium px-1.5 py-0.5 ${event.review_status === 'pending'
                                                        ? 'bg-amber-50 text-amber-700'
                                                        : 'bg-emerald-50 text-success'
                                                        }`}
                                                >
                                                    {event.review_status ?? 'reviewed'}
                                                </span>
                                                {event.is_blocked && (
                                                    <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 bg-slate-200 text-ink">Blocked</span>
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
                                                        className="text-[9px] px-1 py-0 bg-gray-100 text-ink-soft truncate max-w-[60px]"
                                                    >
                                                        {t.label}
                                                    </span>
                                                ))}
                                                {event.tags.length > 2 && (
                                                    <span className="text-[9px] text-muted">+{event.tags.length - 2}</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                                            {event.review_status === 'pending' && (
                                                <button
                                                    onClick={() => handleSingleReview(event.event_id)}
                                                    className="text-[10px] text-action hover:text-blue-800 font-medium"
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
                    <div className="flex items-center justify-between px-4 py-2 border-t border-line bg-canvas shrink-0">
                        <span className="text-[10px] text-muted">
                            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                        </span>
                        <div className="flex gap-1">
                            <button
                                onClick={() => setPage((p) => Math.max(0, p - 1))}
                                disabled={page === 0}
                                className="text-[10px] px-2 py-1 border border-line text-ink-soft hover:bg-canvas disabled:opacity-40 transition"
                            >
                                ← Prev
                            </button>
                            <button
                                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                                disabled={page >= totalPages - 1}
                                className="text-[10px] px-2 py-1 border border-line text-ink-soft hover:bg-canvas disabled:opacity-40 transition"
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
                    <div className="px-4 py-2.5 border-t border-blue-200 bg-surface shrink-0">
                        <p className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide mb-2">Assign tags to {selectedIds.size} event(s)</p>
                        <div className="mb-2 max-h-64 overflow-y-auto">
                            <TagsPicker
                                tagGroups={tagGroups}
                                value={{ selectedTagIds: bulkTagIds, freeTexts: {} }}
                                onChange={(next) => setBulkTagIds(next.selectedTagIds)}
                                searchable
                                allowFreeText={false}
                            />
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={handleBulkAssignTags}
                                disabled={bulkTagIds.length === 0 || !!busy}
                                className="text-[10px] font-medium px-2.5 py-1 bg-action text-white hover:bg-action-strong disabled:opacity-50 transition"
                            >
                                {busy === 'bulk-tags' ? 'Applying…' : `Apply ${bulkTagIds.length > 0 ? `(${bulkTagIds.length})` : ''}`}
                            </button>
                            <button
                                onClick={() => { setBulkTagPickerOpen(false); setBulkTagIds([]); }}
                                className="text-[10px] text-ink-soft hover:text-ink"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Group-as-series title entry */}
                {seriesTitlePickerOpen && (
                    <div className="px-4 py-2.5 border-t border-teal-200 bg-surface shrink-0 space-y-2">
                        <p className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide">
                            Group {selectedIds.size} event(s) into a series
                        </p>
                        <input
                            type="text"
                            value={seriesTitleDraft}
                            onChange={(e) => setSeriesTitleDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmGroupAsSeries(); }}
                            placeholder="Series title"
                            className="w-full text-[11px] border border-line px-2 py-1"
                        />
                        <div className="flex gap-2">
                            <button
                                onClick={handleConfirmGroupAsSeries}
                                disabled={!!busy}
                                className="text-[10px] font-medium px-2.5 py-1 bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 transition"
                            >
                                {busy === 'bulk-series' ? 'Grouping…' : 'Create series'}
                            </button>
                            <button
                                onClick={() => { setSeriesTitlePickerOpen(false); setSeriesTitleDraft(''); }}
                                className="text-[10px] text-ink-soft hover:text-ink"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Add-to-series picker */}
                {addSeriesPickerOpen && (
                    <div className="px-4 py-2.5 border-t border-purple-200 bg-surface shrink-0 space-y-2">
                        <p className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide">
                            Add {selectedIds.size} event(s) to an existing series
                        </p>
                        <input
                            type="text"
                            value={seriesSearch}
                            onChange={(e) => setSeriesSearch(e.target.value)}
                            placeholder="Search series by title…"
                            className="w-full text-[11px] border border-line px-2 py-1"
                        />
                        {seriesSearch.trim().length >= 3 && (
                            <div className="max-h-40 overflow-y-auto border border-line bg-surface">
                                {seriesSearchLoading ? (
                                    <p className="px-2 py-2 text-[10px] text-ink-soft">Searching…</p>
                                ) : seriesSearchResults.length === 0 ? (
                                    <p className="px-2 py-2 text-[10px] text-ink-soft">No series found.</p>
                                ) : seriesSearchResults.map((s) => (
                                    <button
                                        key={s.id}
                                        onClick={() => handleAddToSeries(s.id)}
                                        disabled={!!busy}
                                        className="flex w-full items-center justify-between gap-2 border-b border-card-line px-2 py-1.5 text-left last:border-b-0 hover:bg-purple-50 disabled:opacity-50"
                                    >
                                        <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{s.canonical_title}</span>
                                        <span className="text-[10px] text-muted">{s.events.length} event(s) · {s.status}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <button
                            onClick={() => { setAddSeriesPickerOpen(false); setSeriesSearch(''); setSeriesSearchResults([]); }}
                            className="text-[10px] text-ink-soft hover:text-ink"
                        >
                            Cancel
                        </button>
                    </div>
                )}

                {/* Inline series-group result card */}
                {seriesGroupResult && (
                    <div className="px-4 py-2.5 border-t border-emerald-200 bg-emerald-50/40 shrink-0">
                        <div className="flex items-center justify-between mb-2">
                            <p className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide">Series created</p>
                            <button
                                onClick={() => setSeriesGroupResult(null)}
                                className="text-[10px] text-muted hover:text-ink-soft"
                            >
                                Hide
                            </button>
                        </div>
                        <SeriesGroupCard
                            group={seriesGroupResult}
                            acting={inlineActing}
                            onApprove={handleApproveInlineSeries}
                            onDismiss={handleDismissInlineSeries}
                            onRemove={handleSplitInlineSeries}
                            onOpenEvent={(id) => setAdminDetailEventId(id)}
                        />
                    </div>
                )}

                {/* Inline duplicate-group result card */}
                {duplicateGroupResult && (
                    <div className="px-4 py-2.5 border-t border-orange-200 bg-orange-50/40 shrink-0">
                        <div className="flex items-center justify-between mb-2">
                            <p className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide">Flagged as duplicates</p>
                            <button
                                onClick={() => setDuplicateGroupResult(null)}
                                className="text-[10px] text-muted hover:text-ink-soft"
                            >
                                Hide
                            </button>
                        </div>
                        <DuplicateGroupCard
                            group={duplicateGroupResult}
                            acting={inlineActing}
                            onKeep={handleKeepDuplicate}
                            onDismiss={handleDismissDuplicate}
                            onOpenEvent={(id) => setAdminDetailEventId(id)}
                        />
                    </div>
                )}

                {/* Curate-to-Lists Picker */}
                {curatePickerOpen && (
                    <div className="px-4 py-2.5 border-t border-indigo-200 bg-surface shrink-0 space-y-2">
                        <p className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide">
                            Curate {selectedIds.size} event(s) to admin-managed lists
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                            <label className="text-[10px] text-ink-soft flex items-center gap-1">
                                List:
                                <select
                                    value={curateKind}
                                    onChange={(e) => setCurateKind(e.target.value as AdminBulkEngagementKind)}
                                    className="text-[10px] border border-line px-1 py-0.5"
                                >
                                    <option value="save">Saved</option>
                                    <option value="going">Going</option>
                                </select>
                            </label>
                            <label className="text-[10px] text-ink-soft flex items-center gap-1">
                                Audience:
                                <select
                                    value={curateAudience}
                                    onChange={(e) => setCurateAudience(e.target.value as AdminBulkEngagementAudience | '')}
                                    className="text-[10px] border border-line px-1 py-0.5"
                                    title="Per-row audience. Defaults to each target's profile setting when blank."
                                >
                                    <option value="">target default</option>
                                    <option value="public">public</option>
                                    <option value="friends">friends</option>
                                    <option value="private">private</option>
                                </select>
                            </label>
                        </div>
                        <div className="max-h-28 overflow-y-auto border border-line bg-surface">
                            {managedUsers.length === 0 ? (
                                <p className="px-2 py-2 text-[10px] text-ink-soft">No admin-managed users yet.</p>
                            ) : managedUsers.map((u) => {
                                const handle = u.handle ?? '';
                                const active = selectedCurateHandles.has(handle);
                                return (
                                    <label key={u.user_id} className="flex cursor-pointer items-center gap-2 border-b border-card-line px-2 py-1.5 last:border-b-0 hover:bg-canvas">
                                        <input
                                            type="checkbox"
                                            checked={active}
                                            onChange={() => handleToggleCurateHandle(handle)}
                                            className="h-3 w-3"
                                        />
                                        <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                                            @{handle}{u.managed_label ? ` - ${u.managed_label}` : ''}
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                        <p className="text-[10px] text-ink-soft">
                            Only admin-managed users are listed. No notifications are fanned out.
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={handleBulkCurate}
                                disabled={!!busy || selectedCurateHandles.size === 0}
                                className="text-[10px] font-medium px-2.5 py-1 bg-action text-white hover:bg-action disabled:opacity-50 transition"
                            >
                                {busy === 'bulk-curate' ? 'Curating…' : 'Apply'}
                            </button>
                            <button
                                onClick={() => { setCuratePickerOpen(false); setSelectedCurateHandles(new Set()); }}
                                className="text-[10px] text-ink-soft hover:text-ink"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Bulk Action Bar */}
                {selectedIds.size > 0 && (
                    <div className="flex items-center gap-2 px-4 py-2 border-t border-blue-200 bg-blue-50 shrink-0">
                        <span className="text-[10px] font-medium text-action">
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
                            className="text-[10px] font-medium px-2 py-1 bg-action text-white hover:bg-action-strong disabled:opacity-50 transition"
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
                            className="text-[10px] font-medium px-2 py-1 bg-success text-white hover:bg-success/90 disabled:opacity-50 transition"
                            title="Run the heuristic tag suggester on the selected events. Suggestions land as pending — review in the Tag Suggestions panel."
                        >
                            {busy === 'bulk-suggest-tags' ? 'Suggesting…' : 'Auto-suggest Tags'}
                        </button>
                        <button
                            onClick={handleBulkFlagDuplicates}
                            disabled={!!busy || selectedIds.size < 2}
                            className="text-[10px] font-medium px-2 py-1 bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 transition"
                            title="Flag the selected events as duplicates of each other. Review and pick which to keep in the Duplicates panel."
                        >
                            {busy === 'bulk-flag-duplicates' ? 'Flagging…' : 'Flag as Duplicates'}
                        </button>
                        <button
                            onClick={handleGroupAsSeries}
                            disabled={!!busy || selectedIds.size < 2 || selectedIds.size > 20}
                            className="text-[10px] font-medium px-2 py-1 bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 transition"
                            title="Group the selected events (2–20) into a single event series."
                        >
                            {busy === 'bulk-series' ? 'Grouping…' : 'Group as Series'}
                        </button>
                        <button
                            onClick={() => { setAddSeriesPickerOpen((o) => !o); setSeriesSearch(''); setSeriesSearchResults([]); }}
                            disabled={!!busy || selectedIds.size < 1 || selectedIds.size > 20}
                            className="text-[10px] font-medium px-2 py-1 bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition"
                            title="Add the selected events to an existing series."
                        >
                            Add to Series
                        </button>
                        <button
                            onClick={() => { setSelectedIds(new Set()); setAllMatchingSelected(false); setBulkTagPickerOpen(false); }}
                            className="text-[10px] text-ink-soft hover:text-ink px-1"
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
