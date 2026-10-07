import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, RefreshCw, Repeat, SlidersHorizontal, X } from 'lucide-react';
import useBackToClose from '../hooks/useBackToClose';
import useMediaQuery from '../hooks/useMediaQuery';
import useLongPress from '../hooks/useLongPress';
import BottomSheet from './BottomSheet';
import AdminLoadMore from './AdminLoadMore';
import type { CalendarEvent, SeriesGroup, DuplicateGroup } from '../types';
import type {
    AdminEventSort,
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
import MergeEventsDialog from './MergeEventsDialog';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import {
    ADMIN_EVENT_STATUS_CHIP_CLASSES,
    ADMIN_EVENT_STATUS_LABELS,
    getAdminEventRowClass,
    getAdminEventStatus,
    getRemovalReasonLabel,
    hasOpenChanges,
    reviewLockReason,
} from '../utils/adminEventStatus';
import { formatCompactDateRange } from '../utils/eventDates';
import { EventFlagIcons } from './admin-events/AdminEventCells';
import AdminEventsToolbar from './admin-events/AdminEventsToolbar';
import AdminEventsTable from './admin-events/AdminEventsTable';
import AdminEventsColumnsMenu from './admin-events/AdminEventsColumnsMenu';
import FilterEditor from './admin-events/FilterEditor';
import useAdminEventsTablePrefs from './admin-events/useAdminEventsTablePrefs';
import type { AdminColumnContext } from './admin-events/adminEventColumns';
import {
    DEFAULT_FILTERS,
    FILTER_DIMENSIONS,
    FILTER_GROUPS,
    SORT_OPTIONS,
    activeDimensions,
    clearDimension,
    defaultSortOrder,
    dimensionSummary,
    toFilterParams,
    type AdminEventFilterState,
    type SortOrder,
} from './admin-events/adminEventFilters';

export { MatchesCell } from './admin-events/AdminEventCells';

export type EventsPanelPreset = 'all' | 'ungeolocated';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    preset: EventsPanelPreset;
    initialCalendarId?: string;
}

const PAGE_SIZE = 25;

const PRESET_FILTERS: Record<EventsPanelPreset, Partial<EventFilterParams>> = {
    all: {},
    ungeolocated: { ungeolocated: true },
};

const PRESET_TITLES: Record<EventsPanelPreset, string> = {
    all: 'Events',
    ungeolocated: 'Ungeolocated Events',
};

const PRESET_HIDDEN_DIMENSIONS: Record<EventsPanelPreset, string[]> = {
    all: [],
    ungeolocated: ['geo'],
};

export default function EventsPanel({ isOpen, onClose, preset, initialCalendarId }: Props) {
    useBackToClose(onClose, isOpen);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [filterOptions, setFilterOptions] = useState<EventFilterOptionsResponse | null>(null);
    const [filters, setFiltersState] = useState<AdminEventFilterState>(DEFAULT_FILTERS);
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
    const [mergeIds, setMergeIds] = useState<string[] | null>(null);
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
    const [groupBySeries, setGroupBySeries] = useState(false);
    const [sortBy, setSortBy] = useState<AdminEventSort>('start');
    const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
    const tablePrefsState = useAdminEventsTablePrefs();
    const { prefs: tablePrefs, setPrefs: setTablePrefs } = tablePrefsState;
    const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const seriesSearchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const isMobile = useMediaQuery('(max-width: 639px)');
    const bindLongPress = useLongPress();
    // Mobile appends pages; reloads after actions refetch everything already loaded.
    const loadedCountRef = useRef(0);
    const [selectMode, setSelectMode] = useState(false);
    const [filtersSheetOpen, setFiltersSheetOpen] = useState(false);
    const [actionsSheetOpen, setActionsSheetOpen] = useState(false);
    const [prevSelectedCount, setPrevSelectedCount] = useState(0);
    if (prevSelectedCount !== selectedIds.size) {
        setPrevSelectedCount(selectedIds.size);
        if (selectedIds.size === 0 && prevSelectedCount > 0) setSelectMode(false);
    }
    const selecting = isMobile && (selectMode || selectedIds.size > 0);

    const setFilters = (next: AdminEventFilterState) => {
        setFiltersState(next);
        setPage(0);
    };
    const handleSort = (nextSort: AdminEventSort, nextOrder: SortOrder) => {
        setSortBy(nextSort);
        setSortOrder(nextOrder);
        setPage(0);
    };

    // Build filter params from current state
    const buildParams = useCallback(
        (pageOverride?: number): EventFilterParams => {
            const presetFilters = PRESET_FILTERS[preset];
            return {
                ...toFilterParams(filters),
                limit: PAGE_SIZE,
                offset: (pageOverride ?? page) * PAGE_SIZE,
                search: debouncedSearch || undefined,
                ungeolocated: presetFilters.ungeolocated || undefined,
                group: groupBySeries ? 'series' : undefined,
                sort: sortBy,
                order: sortOrder === defaultSortOrder(sortBy) ? undefined : sortOrder,
            };
        },
        [preset, page, debouncedSearch, filters, groupBySeries, sortBy, sortOrder],
    );

    // Load events
    const loadEvents = useCallback(
        async (pageOverride?: number, fresh = false) => {
            setLoading(true);
            try {
                const params = buildParams(pageOverride);
                if (isMobile) {
                    params.offset = 0;
                    params.limit = fresh ? PAGE_SIZE : Math.min(Math.max(loadedCountRef.current, PAGE_SIZE), 100);
                }
                // Fetch filter options without calendar_id so the calendar dropdown
                // always shows all calendars regardless of the current selection.
                const { calendar_id: _calId, ...rest } = params;
                const optionParams = { ...rest, group: undefined, sort: undefined, order: undefined };
                const [eventsRes, optionsRes] = await Promise.all([
                    fetchAdminEvents(params),
                    fetchEventFilterOptions(optionParams),
                ]);
                setEvents(eventsRes.items);
                loadedCountRef.current = eventsRes.items.length;
                setTotal(eventsRes.total);
                setFilterOptions(optionsRes);
            } catch {
                setMessage('Failed to load events.');
            } finally {
                setLoading(false);
            }
        },
        [buildParams, isMobile],
    );

    const loadMore = async () => {
        setLoading(true);
        try {
            const res = await fetchAdminEvents({ ...buildParams(0), offset: loadedCountRef.current, limit: PAGE_SIZE });
            const seen = new Set(events.map((e) => e.event_id));
            const next = [...events, ...res.items.filter((e) => !seen.has(e.event_id))];
            setEvents(next);
            loadedCountRef.current = next.length;
            setTotal(res.total);
        } catch {
            setMessage('Failed to load more events.');
        } finally {
            setLoading(false);
        }
    };

    // Reset state when panel opens or preset changes
    useEffect(() => {
        if (isOpen) {
            setPage(0);
            setSearch('');
            setDebouncedSearch('');
            setFiltersState({ ...DEFAULT_FILTERS, calendar: initialCalendarId ?? '' });
            setSelectedIds(new Set());
            setAllMatchingSelected(false);
            setMessage('');
            setAdminDetailEventId(null);
            setBulkTagPickerOpen(false);
            setBulkTagIds([]);
            setSelectedCurateHandles(new Set());
            setGroupBySeries(false);
            setSortBy('start');
            setSortOrder('asc');
            setSelectMode(false);
            setFiltersSheetOpen(false);
            setActionsSheetOpen(false);
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
            loadEvents(undefined, true);
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

    const hiddenDimensions = PRESET_HIDDEN_DIMENSIONS[preset];
    const activeFilterChips: { key: string; label: string; onRemove: () => void }[] = [
        ...activeDimensions(filters)
            .filter((dim) => !hiddenDimensions.includes(dim.id))
            .map((dim) => ({ key: dim.id, label: dimensionSummary(dim, filters, filterOptions), onRemove: () => setFiltersState(clearDimension(dim, filters)) })),
        ...(groupBySeries ? [{ key: 'series', label: 'Grouped by series', onRemove: () => setGroupBySeries(false) }] : []),
        ...(sortBy !== 'start' || sortOrder !== 'asc'
            ? [{ key: 'sort', label: `Sort: ${SORT_OPTIONS.find((o) => o.value === sortBy)?.label} ${sortOrder === 'asc' ? '↑' : '↓'}`, onRemove: () => handleSort('start', 'asc') }]
            : []),
    ];
    const resetFilters = () => {
        setFilters(DEFAULT_FILTERS);
        setGroupBySeries(false);
        handleSort('start', 'asc');
    };
    const columnContext = useMemo<AdminColumnContext>(() => ({
        selectedIds,
        allPageSelected: events.length > 0 && selectedIds.size === events.length,
        onSelectAll: () => {
            setSelectedIds(selectedIds.size === events.length ? new Set() : new Set(events.map((e) => e.event_id)));
            setAllMatchingSelected(false);
        },
        onToggleSelect: (eventId) => {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(eventId)) next.delete(eventId);
                else next.add(eventId);
                return next;
            });
            setAllMatchingSelected(false);
        },
        onReview: (eventId) => {
            reviewEvent(eventId).then(() => loadEvents()).catch(() => setMessage('Failed to review event.'));
        },
        calendarLabel: (calendarId) => filterOptions?.calendars.find((c) => c.value === calendarId)?.label ?? calendarId,
    }), [selectedIds, events, filterOptions, loadEvents]);

    const n = selectedIds.size;
    type BulkActionKey = 'tags' | 'curate' | 'review' | 'geo' | 'suggest' | 'dups' | 'merge' | 'series' | 'add-series';
    const bulkActions: { key: BulkActionKey; label: string; hint?: string; disabledReason?: string }[] = [
        { key: 'tags', label: 'Assign tags' },
        { key: 'curate', label: 'Curate to lists', hint: 'Saved/Going on admin-managed accounts' },
        { key: 'review', label: 'Mark reviewed' },
        { key: 'geo', label: 'Retry geocoding' },
        { key: 'suggest', label: 'Auto-suggest tags', hint: 'Suggestions land in Tag suggestions' },
        { key: 'dups', label: 'Flag as duplicates', disabledReason: n < 2 ? 'Select 2 or more events' : undefined },
        { key: 'merge', label: 'Merge…', disabledReason: n < 2 || n > 6 ? 'Select 2–6 events' : undefined },
        { key: 'series', label: 'Group as series', disabledReason: n < 2 || n > 20 ? 'Select 2–20 events' : undefined },
        { key: 'add-series', label: 'Add to series', disabledReason: n > 20 ? 'Select up to 20 events' : undefined },
    ];
    const runBulkAction = (key: BulkActionKey) => {
        setActionsSheetOpen(false);
        if (key === 'tags') { setBulkTagIds([]); setBulkTagPickerOpen(true); }
        else if (key === 'curate') setCuratePickerOpen(true);
        else if (key === 'review') handleBulkReview();
        else if (key === 'geo') handleBulkRetryGeo();
        else if (key === 'suggest') handleBulkSuggestTags();
        else if (key === 'dups') handleBulkFlagDuplicates();
        else if (key === 'merge') setMergeIds([...selectedIds]);
        else if (key === 'series') handleGroupAsSeries();
        else { setSeriesSearch(''); setSeriesSearchResults([]); setAddSeriesPickerOpen(true); }
    };

    const enterSelection = (eventId: string) => {
        setSelectMode(true);
        if (!selectedIds.has(eventId)) handleToggleSelect(eventId);
    };
    const exitSelection = () => {
        setSelectMode(false);
        setSelectedIds(new Set());
        setAllMatchingSelected(false);
    };

    const mobileList = (
        <>
            <ul className="divide-y divide-line">
                {events.map((event) => {
                    const status = getAdminEventStatus(event);
                    const checked = selectedIds.has(event.event_id);
                    const thumb = event.image_thumb_url ?? event.image_url;
                    return (
                        <li
                            key={event.event_id}
                            className={`flex select-none items-start gap-1 pr-1 [-webkit-touch-callout:none] ${checked ? 'bg-blue-100' : getAdminEventRowClass(event)} ${hasOpenChanges(event) ? 'border-l-4 border-orange-400' : ''}`}
                            {...bindLongPress(() => enterSelection(event.event_id))}
                        >
                            <button
                                type="button"
                                aria-pressed={selecting ? checked : undefined}
                                onClick={() => (selecting ? handleToggleSelect(event.event_id) : setAdminDetailEventId(event.event_id))}
                                className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 text-left"
                            >
                                {selecting && (
                                    <span aria-hidden="true" className={`mt-3.5 flex h-5 w-5 shrink-0 items-center justify-center border ${checked ? 'border-action bg-action text-white' : 'border-line bg-surface'}`}>
                                        {checked && <Check className="h-3.5 w-3.5" />}
                                    </span>
                                )}
                                {thumb ? (
                                    <img src={thumb} alt="" loading="lazy" className="h-12 w-12 shrink-0 object-cover" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                                ) : (
                                    <span aria-hidden="true" className="h-12 w-12 shrink-0 bg-canvas" style={event.color ? { backgroundColor: event.color, opacity: 0.25 } : undefined} />
                                )}
                                <span className="min-w-0 flex-1">
                                    <span className={`flex items-start gap-1 text-sm font-medium leading-snug ${status === 'cancelled' ? 'text-ink-soft line-through' : 'text-ink'}`}>
                                        {(event.in_series || (event.occurrence_count ?? 1) > 1) && (
                                            <Repeat className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-soft" aria-label="Series" role="img" />
                                        )}
                                        <span className="line-clamp-2">{event.title}</span>
                                    </span>
                                    <span className="mt-0.5 block truncate text-xs text-ink-soft">
                                        {formatCompactDateRange(event)}
                                        {(event.occurrence_count ?? 1) > 1 && ` ×${event.occurrence_count}`}
                                        {event.location && ` · ${event.location}`}
                                    </span>
                                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                                        <span className={`inline-block px-1.5 py-0.5 text-[11px] font-medium ${ADMIN_EVENT_STATUS_CHIP_CLASSES[status]}`}>
                                            {ADMIN_EVENT_STATUS_LABELS[status]}
                                        </span>
                                        {getRemovalReasonLabel(event) && (
                                            <span className="inline-block bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-soft">
                                                {getRemovalReasonLabel(event)}
                                            </span>
                                        )}
                                        <EventFlagIcons event={event} />
                                        <LocationBadge location={event.location} latitude={event.latitude} longitude={event.longitude} size="sm" />
                                    </span>
                                </span>
                            </button>
                            {!selecting && status === 'new' && reviewLockReason(event) === null && (
                                <button
                                    type="button"
                                    onClick={() => handleSingleReview(event.event_id)}
                                    className="mt-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center text-action hover:bg-blue-50"
                                    aria-label="Mark reviewed"
                                >
                                    <Check className="h-5 w-5" aria-hidden="true" />
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
            <AdminLoadMore shown={events.length} total={total} loading={loading} onLoadMore={loadMore} />
        </>
    );

    const sheetPillClass = (active: boolean) =>
        `inline-flex min-h-10 items-center gap-1.5 border px-3 text-sm transition ${active ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft hover:border-action hover:text-action'}`;
    const sheetSection = (label: string, children: ReactNode) => (
        <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{label}</h3>
            {children}
        </section>
    );
    const sheetSwitch = (label: string, on: boolean, toggle: () => void) => (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => { toggle(); setPage(0); }}
            className="flex min-h-12 w-full items-center justify-between gap-3 text-left text-sm text-ink"
        >
            {label}
            {/* eslint-disable-next-line no-restricted-syntax -- toggle switch is a pill by design */}
            <span className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition ${on ? 'bg-action' : 'bg-gray-300'}`}>
                {/* eslint-disable-next-line no-restricted-syntax -- toggle knob is circular */}
                <span className={`inline-block h-5 w-5 rounded-full bg-surface transition ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </span>
        </button>
    );
    const sheetSelectClass = 'min-h-11 w-full border border-line bg-surface px-3 text-base text-ink focus:outline-none focus:ring-1 focus:ring-action';
    const sheetPrimaryClass = 'min-h-11 w-full bg-action text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';

    return (
        <>
            {isOpen && (
                <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
            )}

            <div
                className={`fixed top-0 right-0 h-full w-full sm:w-[1100px] sm:max-w-[95vw] bg-surface shadow-lg sm:border-l border-line z-50 transform transition-transform duration-200 ease-in-out flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {isMobile && (selecting ? (
                    <div className="shrink-0 border-b border-line bg-blue-50 pt-[env(safe-area-inset-top)]">
                        <div className="flex min-h-14 items-center gap-1 px-1">
                            <button type="button" onClick={exitSelection} aria-label="Exit selection" className="inline-flex h-11 w-11 items-center justify-center text-ink">
                                <X className="h-5 w-5" aria-hidden="true" />
                            </button>
                            <span className="flex-1 text-base font-semibold text-ink">{selectedIds.size} selected</span>
                            <button type="button" onClick={handleSelectAll} className="min-h-11 px-3 text-sm font-medium text-action">
                                {events.length > 0 && selectedIds.size === events.length ? 'Deselect all' : 'Select all'}
                            </button>
                        </div>
                        {allMatchingSelected ? (
                            <p className="px-4 pb-2 text-xs text-ink-soft">All {selectedIds.size} matching events selected.</p>
                        ) : events.length > 0 && selectedIds.size === events.length && total > events.length && (
                            <button
                                type="button"
                                onClick={handleSelectAllMatching}
                                disabled={busy === 'select-all'}
                                className="px-4 pb-2 text-left text-xs font-semibold text-action disabled:opacity-50"
                            >
                                {busy === 'select-all' ? 'Selecting…' : `Select all ${total} matching events`}
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line bg-surface px-1 pt-[env(safe-area-inset-top)]">
                        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-11 w-11 items-center justify-center text-ink">
                            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                        </button>
                        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
                            {PRESET_TITLES[preset]}
                            <span className="ml-2 text-sm font-normal text-ink-soft">{total}</span>
                        </h2>
                        <button type="button" onClick={() => loadEvents()} aria-label="Refresh" className="inline-flex h-11 w-11 items-center justify-center text-ink-soft">
                            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => setSelectMode(true)} disabled={events.length === 0} className="min-h-11 px-3 text-sm font-medium text-action disabled:opacity-50">
                            Select
                        </button>
                    </div>
                ))}

                {isMobile && (
                    <div className="shrink-0 space-y-2 border-b border-card-line px-4 py-2">
                        <div className="flex gap-2">
                            <input
                                type="search"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search events…"
                                aria-label="Search events"
                                className="min-h-11 min-w-0 flex-1 border border-line px-3 text-base text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                            />
                            <button
                                type="button"
                                onClick={() => setFiltersSheetOpen(true)}
                                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-line bg-surface px-3 text-sm font-medium text-ink"
                            >
                                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                                Filters
                                {activeFilterChips.length > 0 && (
                                    <span className="inline-flex h-5 min-w-5 items-center justify-center bg-action px-1 text-[11px] font-semibold text-white">{activeFilterChips.length}</span>
                                )}
                            </button>
                        </div>
                        {activeFilterChips.length > 0 && (
                            <div className="-mx-4 flex gap-2 overflow-x-auto px-4">
                                {activeFilterChips.map((chip) => (
                                    <button
                                        key={chip.key}
                                        type="button"
                                        onClick={() => { chip.onRemove(); setPage(0); }}
                                        aria-label={`Remove filter ${chip.label}`}
                                        className="inline-flex min-h-8 shrink-0 items-center gap-1 border border-action bg-blue-50 px-2.5 text-xs font-medium text-action"
                                    >
                                        {chip.label}
                                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Header */}
                {!isMobile && (
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
                )}

                {/* Filter Bar */}
                {!isMobile && (
                    <AdminEventsToolbar
                        search={search}
                        onSearchChange={setSearch}
                        filters={filters}
                        onFiltersChange={setFilters}
                        options={filterOptions}
                        sort={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                        groupBySeries={groupBySeries}
                        onToggleGroupBySeries={() => { setGroupBySeries((v) => !v); setPage(0); }}
                        hiddenDimensions={hiddenDimensions}
                        columnsMenu={(
                            <AdminEventsColumnsMenu
                                prefs={tablePrefs}
                                onChange={setTablePrefs}
                                onReset={tablePrefsState.reset}
                                onSaveAsDefault={tablePrefsState.saveAsDefault}
                                onFactoryReset={tablePrefsState.factoryReset}
                                hasUserDefault={tablePrefsState.hasUserDefault}
                                isDefault={tablePrefsState.isDefault}
                            />
                        )}
                    />
                )}

                {/* Message */}
                {message && (
                    <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 text-[11px] text-action shrink-0 flex items-center justify-between">
                        <span>{message}</span>
                        <button onClick={() => setMessage('')} className="text-blue-400 hover:text-action ml-2">✕</button>
                    </div>
                )}

                {/* Table */}
                <div className="flex-1 overflow-auto">
                    {loading && events.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-muted">
                            <p className="text-xs">Loading…</p>
                        </div>
                    ) : events.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
                            <p className="text-xs">No events match your filters.</p>
                            {activeFilterChips.length > 0 && (
                                <button type="button" onClick={resetFilters} className="border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-canvas">
                                    Clear filters
                                </button>
                            )}
                        </div>
                    ) : isMobile ? mobileList : (
                        <AdminEventsTable
                            events={events}
                            context={columnContext}
                            prefs={tablePrefs}
                            setPrefs={setTablePrefs}
                            sort={sortBy}
                            order={sortOrder}
                            onSort={handleSort}
                            onRowClick={setAdminDetailEventId}
                        />
                    )}
                </div>

                {/* Pagination */}
                {!isMobile && totalPages > 1 && (
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
                {!isMobile && selectedIds.size === events.length && events.length === PAGE_SIZE && total > PAGE_SIZE && !allMatchingSelected && (
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
                {!isMobile && allMatchingSelected && (
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
                {!isMobile && bulkTagPickerOpen && (
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
                {!isMobile && seriesTitlePickerOpen && (
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
                {!isMobile && addSeriesPickerOpen && (
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
                {!isMobile && seriesGroupResult && (
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
                {!isMobile && duplicateGroupResult && (
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
                {!isMobile && curatePickerOpen && (
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
                {selecting && (
                    <div className="shrink-0 border-t border-line bg-surface px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
                        <button
                            type="button"
                            onClick={() => setActionsSheetOpen(true)}
                            disabled={selectedIds.size === 0 || !!busy}
                            className={sheetPrimaryClass}
                        >
                            {busy ? 'Working…' : selectedIds.size === 0 ? 'Tap events to select' : `Actions (${selectedIds.size})`}
                        </button>
                    </div>
                )}
                {!isMobile && selectedIds.size > 0 && (
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
                            onClick={() => setMergeIds([...selectedIds])}
                            disabled={!!busy || selectedIds.size < 2 || selectedIds.size > 6}
                            className="text-[10px] font-medium px-2 py-1 bg-orange-700 text-white hover:bg-orange-800 disabled:opacity-50 transition"
                            title="Merge the selected events (2–6) into one."
                        >
                            Merge…
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

            {isMobile && isOpen && filtersSheetOpen && (
                <BottomSheet
                    title="Filters"
                    onClose={() => setFiltersSheetOpen(false)}
                    headerAction={activeFilterChips.length > 0 ? (
                        <button type="button" onClick={resetFilters} className="min-h-11 px-2 text-sm font-medium text-action">Reset</button>
                    ) : undefined}
                    footer={
                        <button type="button" onClick={() => setFiltersSheetOpen(false)} className={sheetPrimaryClass}>
                            {loading ? 'Loading…' : total === 0 ? 'No matches — close' : `Show ${total} event${total === 1 ? '' : 's'}`}
                        </button>
                    }
                >
                    {filterOptions ? (
                        <div className="space-y-5 pb-2">
                            {sheetSection('Sort', (
                                <div className="flex flex-wrap gap-2">
                                    {SORT_OPTIONS.map(({ value, label }) => (
                                        <button key={value} type="button" aria-pressed={sortBy === value} onClick={() => handleSort(value, defaultSortOrder(value))} className={sheetPillClass(sortBy === value)}>
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            ))}
                            {FILTER_GROUPS.map((group) => {
                                const dims = FILTER_DIMENSIONS.filter((dim) => dim.group === group && !hiddenDimensions.includes(dim.id)
                                    && !('optionsKey' in dim && (filterOptions[dim.optionsKey] ?? []).length === 0));
                                if (dims.length === 0) return null;
                                return (
                                    <div key={group} className="space-y-4">
                                        <h3 className="border-b border-line pb-1 text-xs font-semibold text-ink">{group}</h3>
                                        {dims.map((dim) => (
                                            <div key={dim.id}>
                                                {sheetSection(dim.label, <FilterEditor dim={dim} state={filters} options={filterOptions} onChange={setFilters} size="sheet" />)}
                                            </div>
                                        ))}
                                    </div>
                                );
                            })}
                            <div className="divide-y divide-line border-y border-line">
                                {sheetSwitch('Group by series', groupBySeries, () => setGroupBySeries((v) => !v))}
                            </div>
                        </div>
                    ) : (
                        <p className="py-6 text-center text-sm text-muted">Loading…</p>
                    )}
                </BottomSheet>
            )}

            {isMobile && isOpen && actionsSheetOpen && (
                <BottomSheet title="Bulk actions" subtitle={`${selectedIds.size} event${selectedIds.size === 1 ? '' : 's'} selected`} onClose={() => setActionsSheetOpen(false)}>
                    <ul className="-mx-4 divide-y divide-line">
                        {bulkActions.map((action) => (
                            <li key={action.key}>
                                <button
                                    type="button"
                                    disabled={!!action.disabledReason || !!busy}
                                    onClick={() => runBulkAction(action.key)}
                                    className="flex min-h-12 w-full flex-col justify-center px-4 py-2 text-left hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <span className="text-sm font-medium text-ink">{action.label}</span>
                                    {(action.disabledReason ?? action.hint) && (
                                        <span className="text-xs text-ink-soft">{action.disabledReason ?? action.hint}</span>
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                </BottomSheet>
            )}

            {isMobile && isOpen && bulkTagPickerOpen && (
                <BottomSheet
                    title="Assign tags"
                    subtitle={`${selectedIds.size} event(s)`}
                    onClose={() => { setBulkTagPickerOpen(false); setBulkTagIds([]); }}
                    footer={
                        <button type="button" onClick={handleBulkAssignTags} disabled={bulkTagIds.length === 0 || !!busy} className={sheetPrimaryClass}>
                            {busy === 'bulk-tags' ? 'Applying…' : `Apply${bulkTagIds.length > 0 ? ` (${bulkTagIds.length})` : ''}`}
                        </button>
                    }
                >
                    <TagsPicker
                        tagGroups={tagGroups}
                        value={{ selectedTagIds: bulkTagIds, freeTexts: {} }}
                        onChange={(next) => setBulkTagIds(next.selectedTagIds)}
                        searchable
                        allowFreeText={false}
                    />
                </BottomSheet>
            )}

            {isMobile && isOpen && seriesTitlePickerOpen && (
                <BottomSheet
                    title="Group as series"
                    subtitle={`${selectedIds.size} event(s)`}
                    onClose={() => { setSeriesTitlePickerOpen(false); setSeriesTitleDraft(''); }}
                    footer={
                        <button type="button" onClick={handleConfirmGroupAsSeries} disabled={!!busy} className={sheetPrimaryClass}>
                            {busy === 'bulk-series' ? 'Grouping…' : 'Create series'}
                        </button>
                    }
                >
                    <input
                        type="text"
                        value={seriesTitleDraft}
                        onChange={(e) => setSeriesTitleDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmGroupAsSeries(); }}
                        placeholder="Series title"
                        aria-label="Series title"
                        className={sheetSelectClass}
                    />
                </BottomSheet>
            )}

            {isMobile && isOpen && addSeriesPickerOpen && (
                <BottomSheet
                    title="Add to series"
                    subtitle={`${selectedIds.size} event(s)`}
                    onClose={() => { setAddSeriesPickerOpen(false); setSeriesSearch(''); setSeriesSearchResults([]); }}
                >
                    <input
                        type="search"
                        value={seriesSearch}
                        onChange={(e) => setSeriesSearch(e.target.value)}
                        placeholder="Search series by title…"
                        aria-label="Search series"
                        className={sheetSelectClass}
                    />
                    {seriesSearch.trim().length >= 3 && (
                        <div className="-mx-4 mt-2 divide-y divide-line">
                            {seriesSearchLoading ? (
                                <p className="px-4 py-3 text-sm text-ink-soft">Searching…</p>
                            ) : seriesSearchResults.length === 0 ? (
                                <p className="px-4 py-3 text-sm text-ink-soft">No series found.</p>
                            ) : seriesSearchResults.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => handleAddToSeries(s.id)}
                                    disabled={!!busy}
                                    className="flex min-h-12 w-full flex-col justify-center px-4 py-2 text-left hover:bg-canvas disabled:opacity-50"
                                >
                                    <span className="truncate text-sm text-ink">{s.canonical_title}</span>
                                    <span className="text-xs text-ink-soft">{s.events.length} event(s) · {s.status}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </BottomSheet>
            )}

            {isMobile && isOpen && curatePickerOpen && (
                <BottomSheet
                    title="Curate to lists"
                    subtitle={`${selectedIds.size} event(s) · no notifications are sent`}
                    onClose={() => { setCuratePickerOpen(false); setSelectedCurateHandles(new Set()); }}
                    footer={
                        <button type="button" onClick={handleBulkCurate} disabled={!!busy || selectedCurateHandles.size === 0} className={sheetPrimaryClass}>
                            {busy === 'bulk-curate' ? 'Curating…' : `Apply${selectedCurateHandles.size > 0 ? ` (${selectedCurateHandles.size})` : ''}`}
                        </button>
                    }
                >
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-1 text-xs text-ink-soft">
                                List
                                <select value={curateKind} onChange={(e) => setCurateKind(e.target.value as AdminBulkEngagementKind)} className={sheetSelectClass}>
                                    <option value="save">Saved</option>
                                    <option value="going">Going</option>
                                </select>
                            </label>
                            <label className="space-y-1 text-xs text-ink-soft">
                                Audience
                                <select value={curateAudience} onChange={(e) => setCurateAudience(e.target.value as AdminBulkEngagementAudience | '')} className={sheetSelectClass}>
                                    <option value="">Target default</option>
                                    <option value="public">Public</option>
                                    <option value="friends">Friends</option>
                                    <option value="private">Private</option>
                                </select>
                            </label>
                        </div>
                        {sheetSection('Admin-managed accounts', managedUsers.length === 0 ? (
                            <p className="text-sm text-ink-soft">No admin-managed users yet.</p>
                        ) : (
                            <div className="-mx-4 divide-y divide-line border-y border-line">
                                {managedUsers.map((u) => {
                                    const handle = u.handle ?? '';
                                    return (
                                        <label key={u.user_id} className="flex min-h-12 cursor-pointer items-center gap-3 px-4">
                                            <input
                                                type="checkbox"
                                                checked={selectedCurateHandles.has(handle)}
                                                onChange={() => handleToggleCurateHandle(handle)}
                                                className="h-5 w-5"
                                            />
                                            <span className="min-w-0 flex-1 truncate text-sm text-ink">
                                                @{handle}{u.managed_label ? ` - ${u.managed_label}` : ''}
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                </BottomSheet>
            )}

            {isMobile && isOpen && seriesGroupResult && (
                <BottomSheet title="Series created" onClose={() => setSeriesGroupResult(null)}>
                    <SeriesGroupCard
                        group={seriesGroupResult}
                        acting={inlineActing}
                        onApprove={handleApproveInlineSeries}
                        onDismiss={handleDismissInlineSeries}
                        onRemove={handleSplitInlineSeries}
                    />
                </BottomSheet>
            )}

            {isMobile && isOpen && duplicateGroupResult && (
                <BottomSheet title="Flagged as duplicates" onClose={() => setDuplicateGroupResult(null)}>
                    <DuplicateGroupCard
                        group={duplicateGroupResult}
                        acting={inlineActing}
                        onKeep={handleKeepDuplicate}
                        onDismiss={handleDismissDuplicate}
                    />
                </BottomSheet>
            )}

            {/* Admin event detail side panel */}
            <AdminEventDetailPanel
                eventId={adminDetailEventId}
                onClose={() => setAdminDetailEventId(null)}
                onEventUpdated={() => loadEvents()}
            />
            {mergeIds && (
                <MergeEventsDialog
                    eventIds={mergeIds}
                    onClose={() => setMergeIds(null)}
                    onMerged={(result) => {
                        setMergeIds(null);
                        setSelectedIds(new Set());
                        setAllMatchingSelected(false);
                        setMessage(`Merged ${result.merged_event_ids.length + 1} events.`);
                        notifyAdminDataChanged();
                        loadEvents();
                    }}
                />
            )}
        </>
    );
}
