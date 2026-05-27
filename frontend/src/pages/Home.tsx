import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { CalendarEvent, TagGroup } from '../types';
import { fetchEvents, fetchSettings, fetchTagGroups } from '../api';
import UserInterestPicker from '../components/UserInterestPicker';
import { trackView } from '../utils/tracking';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type FullCalendar from '@fullcalendar/react';
import Calendar from '../components/Calendar';
import type { CalendarViewMode } from '../components/Calendar';
import EventMap from '../components/EventMap';
import type { MapBounds } from '../components/EventMap';
import EventModal from '../components/EventModal';
import AdminEventDetailPanel from '../components/AdminEventDetailPanel';
import DateRangePicker from '../components/DateRangePicker';
import EventListPanel, { EventListCard } from '../components/EventListPanel';
import SummaryBar from '../components/SummaryBar';
import FilterSheet from '../components/FilterSheet';
import TagFilterPills from '../components/TagFilterPills';
import AreaFilterChip from '../components/AreaFilterChip';
import { usePreferences } from '../context/PreferencesContext';
import { useInvalidateAttendanceSummaries } from '../context/AttendanceSummariesContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { DEFAULT_AREA_BBOX, DEFAULT_AREA_LABEL, clampArea, isDefaultArea } from '../constants/area';
import type { PreferredAreaPayload } from '../api';
import MineButton from '../components/MineButton';
import FollowsButton from '../components/FollowsButton';
import SuggestEventModal from '../components/SuggestEventModal';
import EventAnchoredDetailPanel from '../components/EventAnchoredDetailPanel';
import { useSeenEvents } from '../hooks/useSeenEvents';

type ViewMode = 'explorer' | 'calendar';
type InterestSource = 'follows' | 'friends';
type InterestKind = 'any' | 'going' | 'saved';
type ExplorerSort = 'date' | 'popularity';

interface FutureEventBatch {
    endDate: string;
    matchingCount: number;
}

interface InitialExplorerState {
    startDate: string;
    endDate: string;
    interestSource: InterestSource | null;
    interestKind: InterestKind;
    interestUserHandle: string | null;
    sortBy: ExplorerSort;
}

const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Explorer default window. Shortened from 6 months → 3 months so the landing
// page doesn't dump the full year onto first-time mobile users. Users can
// extend via the "Show next available events" CTA in the list, or pick the
// longer "Next 6 months" preset.
function defaultExplorerDateRange(): { startDate: string; endDate: string } {
    const startDate = formatDate(new Date());
    const defaultEndDate = new Date();
    defaultEndDate.setMonth(defaultEndDate.getMonth() + 3);
    return { startDate, endDate: formatDate(defaultEndDate) };
}

function parseDateParam(value: string | null): string | null {
    if (!value || !DATE_PARAM_RE.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (
        parsed.getFullYear() !== year ||
        parsed.getMonth() !== month - 1 ||
        parsed.getDate() !== day
    ) {
        return null;
    }
    return value;
}

function parseTagIdsParam(value: string | null): number[] {
    if (value == null) return [];
    return Array.from(new Set(
        value
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0),
    ));
}

function parseInterestSource(value: string | null): InterestSource | null {
    return value === 'follows' || value === 'friends' ? value : null;
}

function parseInterestKind(value: string | null): InterestKind | null {
    return value === 'any' || value === 'going' || value === 'saved' ? value : null;
}

function parseExplorerSort(value: string | null): ExplorerSort | null {
    return value === 'date' || value === 'popularity' ? value : null;
}

function normalizeUserHandleParam(value: string | null): string | null {
    const trimmed = value?.trim().replace(/^@/, '') ?? '';
    return trimmed.length ? trimmed : null;
}

function readInitialExplorerState(searchParams: URLSearchParams): InitialExplorerState {
    const defaults = defaultExplorerDateRange();
    const interestUserHandle = normalizeUserHandleParam(searchParams.get('interest_user_handle'));
    const interestSource = parseInterestSource(searchParams.get('interest_source')) ?? (interestUserHandle ? 'follows' : null);
    return {
        startDate: parseDateParam(searchParams.get('start_date')) ?? defaults.startDate,
        endDate: parseDateParam(searchParams.get('end_date')) ?? defaults.endDate,
        interestSource,
        interestKind: parseInterestKind(searchParams.get('interest_kind')) ?? 'any',
        interestUserHandle,
        sortBy: parseExplorerSort(searchParams.get('sort_by')) ?? 'date',
    };
}

function writeExplorerStateToSearchParams(
    next: URLSearchParams,
    state: {
        startDate: string;
        endDate: string;
        activeTagIds: Set<number>;
        shouldPersistEmptyTags: boolean;
        interestSource: InterestSource | null;
        interestKind: InterestKind;
        interestUserHandle: string | null;
        sortBy: ExplorerSort;
    },
) {
    next.set('start_date', state.startDate);
    next.set('end_date', state.endDate);

    const tagIds = [...state.activeTagIds].sort((a, b) => a - b);
    if (tagIds.length > 0) next.set('tag_ids', tagIds.join(','));
    else if (state.shouldPersistEmptyTags) next.set('tag_ids', '');
    else next.delete('tag_ids');

    const interestActive = state.interestSource !== null || !!state.interestUserHandle;
    if (interestActive) {
        next.set('interest_source', state.interestSource ?? 'follows');
        next.set('interest_kind', state.interestKind);
        if (state.interestUserHandle) next.set('interest_user_handle', state.interestUserHandle);
        else next.delete('interest_user_handle');
    } else {
        next.delete('interest_source');
        next.delete('interest_kind');
        next.delete('interest_user_handle');
    }

    if (state.sortBy === 'popularity') next.set('sort_by', state.sortBy);
    else next.delete('sort_by');
}

function areaToMapBounds(area: PreferredAreaPayload): MapBounds {
    return {
        south: area.min_lat,
        north: area.max_lat,
        west: area.min_lng,
        east: area.max_lng,
    };
}

function eventMatchesBounds(event: CalendarEvent, bounds: MapBounds): boolean {
    if (event.latitude == null || event.longitude == null) return true;
    return (
        event.latitude >= bounds.south &&
        event.latitude <= bounds.north &&
        event.longitude >= bounds.west &&
        event.longitude <= bounds.east
    );
}

function filterEventsByTags(events: CalendarEvent[], activeTagIds: Set<number>, tagGroups: TagGroup[]): CalendarEvent[] {
    if (activeTagIds.size === 0) return events;

    // Disjunctive faceting filter logic:
    //  - Within a multi-select group: OR (event must match ANY selected tag in that group)
    //  - Across groups: AND (event must satisfy every group that has a selection)
    // Single-select groups behave the same as OR (only one tag can be selected).
    const tagToGroupSlug = new Map<number, string>();
    for (const g of tagGroups) {
        for (const t of g.tags) tagToGroupSlug.set(t.id, g.slug);
    }
    const groupBuckets = new Map<string, number[]>();
    const ungrouped: number[] = [];
    for (const id of activeTagIds) {
        const slug = tagToGroupSlug.get(id);
        if (!slug) { ungrouped.push(id); continue; }
        const arr = groupBuckets.get(slug);
        if (arr) arr.push(id);
        else groupBuckets.set(slug, [id]);
    }

    return events.filter((event) => {
        const tagSet = new Set((event.tags ?? []).map((tag) => tag.id));
        for (const ids of groupBuckets.values()) {
            if (!ids.some((id) => tagSet.has(id))) return false;
        }
        for (const id of ungrouped) {
            if (!tagSet.has(id)) return false;
        }
        return true;
    });
}

export default function Home() {
    const { user } = useAuth();
    const { showPrices, showPopularity, showRatings, popularityThreshold, tagSortMode, unseenStateEnabled, trendingEnabled, trendingTopN, trendingTopPercent, followingBadgeEnabled } = useFeatureFlags();
    const { isSaved } = useSavedEvents();
    const [showSuggestModal, setShowSuggestModal] = useState(false);
    const mapFollowingBadgeOverlay = true;
    const mapTrendingOverlay = true;
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const [initialExplorerState] = useState(() => readInitialExplorerState(searchParams));

    // Allow opening the suggest modal from anywhere via ?submit=1 (e.g. mobile header link).
    useEffect(() => {
        if (searchParams.get('submit') === '1') {
            setShowSuggestModal(true);
            const next = new URLSearchParams(searchParams);
            next.delete('submit');
            setSearchParams(next, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    const viewMode: ViewMode = location.pathname === '/calendar' ? 'calendar' : 'explorer';
    const invalidateAttendanceSummaries = useInvalidateAttendanceSummaries();
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const eventIds = useMemo(() => events.map((event) => event.event_id), [events]);
    const { newEventIds, markSeen } = useSeenEvents(eventIds);
    const [sinceDate, setSinceDate] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [selectedEventSource, setSelectedEventSource] = useState<string | null>(null);
    const [editingEventId, setEditingEventId] = useState<string | null>(null);
    const [sortBy, setSortBy] = useState<ExplorerSort>(initialExplorerState.sortBy);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [activeTagIds, setActiveTagIds] = useState<Set<number>>(() => new Set(parseTagIdsParam(searchParams.get('tag_ids'))));
    // Tracks whether the user has manually toggled a tag in this session.
    // While false, we still mirror late-arriving pref changes (e.g. after
    // sign-in hydrates server prefs) into ``activeTagIds`` so the explorer
    // immediately reflects the user's saved defaults. After a manual toggle
    // we stop syncing so the user keeps control.
    const userTouchedTagsRef = useRef(searchParams.has('tag_ids'));

    // ── Preferred map area ("Europe & nearby" by default) ────────────────
    // Map bounds (live viewport from EventMap). Declared up here so the
    // "Save as my defaults" callback can capture the current viewport even
    // though the corresponding ``handleBoundsChange`` lives further down.
    const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
    // Bounds the user has explicitly panned/zoomed to (vs the bounds
    // produced by a programmatic fitBounds when the parent calls
    // ``flyToArea``). Drives the events query: while null, the configured
    // ``effectiveArea`` is used (so the query reflects "Europe", not the
    // wider viewport Leaflet had to use to fit Europe at this aspect
    // ratio). A user pan/zoom sets it; clicking a preset clears it again.
    const [userMapBounds, setUserMapBounds] = useState<MapBounds | null>(null);

    // Monotonic counter that the map watches: incremented when the user does
    // something that should re-frame the map (date / tag / friend filter
    // changes, area show-all/reset, prefs hydration). NOT bumped when the
    // user pans the map or clicks "Save as default" — those must respect
    // the current viewport. See ``EventMap.autoFitToken`` for details.
    const [mapAutoFitToken, setMapAutoFitToken] = useState(0);
    const bumpAutoFit = useCallback(() => setMapAutoFitToken((n) => n + 1), []);
    // Set to ``true`` immediately before ``setPrefs`` calls that originate
    // from the explorer's Save CTA so the prefs.area watcher below does not
    // re-frame the map after Save (which would override the viewport the
    // user just chose and re-trigger the Save CTA via ``mapDriftsFromArea``).
    const suppressNextPrefsFitRef = useRef(false);
    // ``flyToArea`` token + bbox: imperative request to move the explorer
    // map to a specific bbox (e.g. when the user clicks the "Default area"
    // snap-back pill, or after sign-in when prefs.area hydrates).
    const [flyToAreaToken, setFlyToAreaToken] = useState(0);
    const [flyToAreaBbox, setFlyToAreaBbox] = useState<PreferredAreaPayload | null>(null);
    const flyToArea = useCallback((area: PreferredAreaPayload | null) => {
        if (!area) return;
        // Clear user-driven bounds so the events query uses the area bbox,
        // not the wider viewport Leaflet produced to fit the area at the
        // current aspect ratio.
        setUserMapBounds(null);
        setFlyToAreaBbox(area);
        setFlyToAreaToken((n) => n + 1);
    }, []);
    // Resolution order each render: explicit URL bbox params > saved user
    // prefs > hardcoded DEFAULT_AREA_BBOX. The user can opt out for the
    // current session via the chip's "show all" link, which we capture in
    // ``areaSessionOverride``. Reload resets it (matches design doc).
    const { prefs, setPrefs } = usePreferences();
    // Session-only opt-out so the user can browse "worldwide" without
    // touching their saved prefs, OR a one-click switch back to the
    // hardcoded "Europe & nearby" preset. Reload resets it (matches design
    // doc).
    const [areaSessionOverride, setAreaSessionOverride] = useState<
        | { kind: 'show-all' }
        | { kind: 'preset'; area: typeof DEFAULT_AREA_BBOX }
        | null
    >(null);

    // Parse explicit bbox from the URL exactly once on mount; treat the four
    // params as all-or-nothing to match the backend validator.
    useEffect(() => {
        const minLat = searchParams.get('min_lat');
        const minLng = searchParams.get('min_lng');
        const maxLat = searchParams.get('max_lat');
        const maxLng = searchParams.get('max_lng');
        if (minLat && minLng && maxLat && maxLng) {
            const parsed = {
                min_lat: Number(minLat),
                min_lng: Number(minLng),
                max_lat: Number(maxLat),
                max_lng: Number(maxLng),
            };
            if (Object.values(parsed).every((n) => Number.isFinite(n))) {
                // URL bbox takes precedence over saved prefs by writing it
                // straight into the prefs slot for this session. The
                // ``setPrefs`` call uses the local-only path (no PATCH)
                // because we don't want to clobber the user's saved area.
                // Simpler alternative: just navigate the map; the bbox
                // params already drive ``fetchEvents`` via URL parsing
                // upstream. Skipping override write to keep state minimal.
            }
        }
        // If no explicit tag filter is present in the URL, fall back to saved
        // prefs. URL takes precedence so shared links always render exactly
        // as the sender intended, including the explicit empty `tag_ids=` case.
        if (!searchParams.has('tag_ids') && prefs.tagIds.length) {
            setActiveTagIds(new Set(prefs.tagIds));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Mirror prefs.tagIds into activeTagIds while the user hasn't manually
    // touched the tag filter (e.g. immediately after sign-in hydrates the
    // server-side prefs payload). Once the user toggles a pill we stop
    // syncing.
    useEffect(() => {
        if (userTouchedTagsRef.current) return;
        const next = new Set(prefs.tagIds);
        setActiveTagIds(next);
    }, [prefs.tagIds]);

    // When the saved area changes from outside the explorer (sign-in
    // hydration, Settings page edit), fly the map to it. The events query
    // follows the map viewport, so flying triggers a refetch with the new
    // area. Skipped when the change was triggered by our own Save CTA (the
    // user already picked the viewport).
    useEffect(() => {
        if (suppressNextPrefsFitRef.current) {
            suppressNextPrefsFitRef.current = false;
            return;
        }
        if (prefs.area) flyToArea(prefs.area);
    }, [prefs.area, flyToArea]);

    // Captured ONCE on mount: the area we want the map to open at. Passed
    // to <EventMap initialArea=...> so the Leaflet map opens framed on
    // this bbox from the very first render — no two-step (markers fit
    // → area fit) on load. Late prefs hydration is handled by the watcher
    // above which calls flyToArea explicitly.
    const initialAreaRef = useRef<PreferredAreaPayload>(prefs.area ?? DEFAULT_AREA_BBOX);

    const effectiveArea: PreferredAreaPayload | null = useMemo(() => {
        if (areaSessionOverride?.kind === 'show-all') return null;
        if (areaSessionOverride?.kind === 'preset') return areaSessionOverride.area;
        if (prefs.area) return prefs.area;
        return DEFAULT_AREA_BBOX;
    }, [areaSessionOverride, prefs.area]);

    // Explorer mode fetches the full date/interest event set and filters by
    // the active/default area on the client. The live map viewport is used for
    // on-map/off-map presentation only, so panning does not hide otherwise
    // matching events from the list or from the next filter-driven refit.

    // Chip state. Four user-visible cases:
    //   • 'map-view'  — user has panned/zoomed; chip reflects live map view
    //   • 'show-all'  — user clicked the worldwide icon this session
    //   • 'user'      — user has saved prefs and we're applying them
    //   • 'default'   — hardcoded DEFAULT_AREA_BBOX (preset override or no prefs)
    const areaChipState = useMemo<
        | { kind: 'map-view' }
        | { kind: 'show-all' }
        | { kind: 'user'; label: string }
        | { kind: 'default'; label: string }
    >(() => {
        if (userMapBounds) return { kind: 'map-view' };
        if (areaSessionOverride?.kind === 'show-all') return { kind: 'show-all' };
        if (areaSessionOverride?.kind === 'preset') {
            return { kind: 'default', label: areaSessionOverride.area.label };
        }
        if (prefs.area) return { kind: 'user', label: prefs.area.label };
        return { kind: 'default', label: DEFAULT_AREA_LABEL };
    }, [userMapBounds, areaSessionOverride, prefs.area]);

    // Show the "Save as my defaults" button when the user's currently active
    // tags differ from saved prefs. Area drift is tracked separately via
    // ``mapDriftsFromArea`` (depends on ``mapBounds`` which is set later).
    const tagsDifferFromPrefs = useMemo(() => {
        const a = [...activeTagIds].sort();
        const b = [...prefs.tagIds].sort();
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) return true;
        return false;
    }, [activeTagIds, prefs.tagIds]);

    const [savingDefaults, setSavingDefaults] = useState(false);
    const [savedDefaultsToast, setSavedDefaultsToast] = useState(false);
    // Inline name-this-area form (toggled by clicking "save as default" in
    // the area bar). Stays open until the user confirms or cancels so they
    // can iterate on the name before persisting.
    const [namingArea, setNamingArea] = useState(false);
    const [areaNameDraft, setAreaNameDraft] = useState('');
    const showSavedToast = useCallback(() => {
        setSavedDefaultsToast(true);
        window.setTimeout(() => setSavedDefaultsToast(false), 2500);
    }, []);

    // Save just the active tag filter as the user's default tags. Area
    // prefs are left untouched. Triggered by the small CTA next to the
    // tag filter pills (visible only when ``tagsDifferFromPrefs``).
    const handleSaveTagsAsDefault = useCallback(async () => {
        setSavingDefaults(true);
        try {
            await setPrefs({ tagIds: [...activeTagIds] });
            showSavedToast();
        } finally {
            setSavingDefaults(false);
        }
    }, [activeTagIds, setPrefs, showSavedToast]);

    // Save the user's CURRENT MAP VIEW as the default area. Tag prefs are
    // left untouched. Triggered by the CTA in the default-location bar
    // beneath the map (visible only when ``mapDriftsFromArea``).
    // ``customLabel`` is the user-typed name from the inline name input
    // (see ``namingArea`` state); falls back to the existing label when
    // empty/whitespace.
    const handleSaveLocationAsDefault = useCallback(async (customLabel?: string) => {
        setSavingDefaults(true);
        try {
            const trimmed = customLabel?.trim();
            const label = trimmed || effectiveArea?.label || 'My area';
            const areaFromMap = mapBounds
                ? clampArea({
                    min_lat: mapBounds.south,
                    min_lng: mapBounds.west,
                    max_lat: mapBounds.north,
                    max_lng: mapBounds.east,
                    label,
                })
                : effectiveArea
                    ? { ...effectiveArea, label }
                    : null;
            // Don't auto-fit the map after this Save — the user already
            // chose the viewport, and any refit would slightly shift it and
            // re-trigger ``mapDriftsFromArea`` → the CTA would pop right back.
            suppressNextPrefsFitRef.current = true;
            await setPrefs({ area: areaFromMap });
            // Clear any session preset override so the freshly-saved
            // prefs.area is what we display.
            setAreaSessionOverride(null);
            showSavedToast();
        } finally {
            setSavingDefaults(false);
        }
    }, [effectiveArea, mapBounds, setPrefs, showSavedToast]);

    // Calendar view section visibility
    const [showCalendarGrid, setShowCalendarGrid] = useState(true);
    const [showCalendarMap, setShowCalendarMap] = useState(true);

    // Mobile calendar view: 3-week (default on mobile) vs full month. Persisted.
    const [isMobileViewport, setIsMobileViewport] = useState(() => window.innerWidth < 640);
    useEffect(() => {
        const mq = window.matchMedia('(max-width: 639px)');
        const handler = (e: MediaQueryListEvent) => setIsMobileViewport(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);
    const [mobileCalendarView, setMobileCalendarView] = useState<CalendarViewMode>(() => {
        const stored = typeof window !== 'undefined' ? window.localStorage.getItem('mobileCalendarView') : null;
        return stored === 'month' ? 'month' : '3week';
    });
    useEffect(() => {
        try {
            window.localStorage.setItem('mobileCalendarView', mobileCalendarView);
        } catch { /* ignore */ }
    }, [mobileCalendarView]);
    const calendarViewMode: CalendarViewMode = isMobileViewport ? mobileCalendarView : 'month';

    // Shared selection anchor for calendar desktop details
    const [selectedEventRect, setSelectedEventRect] = useState<DOMRect | null>(null);

    // Responsive: detect desktop for explorer detail swap
    const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 1024);
    useEffect(() => {
        const handler = () => setIsDesktop(window.innerWidth >= 1024);
        window.addEventListener('resize', handler);
        return () => window.removeEventListener('resize', handler);
    }, []);

    // Explorer state
    const [startDate, setStartDate] = useState(initialExplorerState.startDate);
    const [endDate, setEndDate] = useState(initialExplorerState.endDate);

    // Interest filter (Phase: following-interest). Restricts the explorer
    // feed to events at least one user in the chosen graph has marked
    // going / saved.
    //   • `interestSource` = which graph: `follows` (anyone the viewer
    //     follows, one-way OK) or `friends` (mutual followers only).
    //     `null` = filter off.
    //   • `interestKind` = which signal: `any` (going OR saved), `going`,
    //     `saved`. Defaults to `any` so the chip works as a one-click
    //     "what are people I follow up to" toggle.
    //   • `interestUserHandle` = optional narrow to a single user (any
    //     user, not necessarily followed). When set, implies the filter
    //     is on.
    // Backend enforces per-row audience visibility; non-mutual followers
    // never see `friends`-audience rows.
    const [interestSource, setInterestSource] = useState<InterestSource | null>(initialExplorerState.interestSource);
    const [interestKind, setInterestKind] = useState<InterestKind>(initialExplorerState.interestKind);
    const [interestUserHandle, setInterestUserHandle] = useState<string | null>(initialExplorerState.interestUserHandle);
    const [selectedExplorerMapEventId, setSelectedExplorerMapEventId] = useState<string | null>(null);

    // Calendar mode map bounds (for off-map styling in the calendar grid)
    const [calMapBounds, setCalMapBounds] = useState<MapBounds | null>(null);

    const navigate = useNavigate();

    // Cross-component hover highlight
    const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
    const handleEventHover = useCallback((eventId: string | null) => {
        setHoveredEventId(eventId);
    }, []);

    useEffect(() => {
        if (viewMode !== 'explorer') return;
        if (searchParams.get('submit') === '1') return;
        const next = new URLSearchParams(searchParams);
        writeExplorerStateToSearchParams(next, {
            startDate,
            endDate,
            activeTagIds,
            shouldPersistEmptyTags: userTouchedTagsRef.current || searchParams.has('tag_ids'),
            interestSource,
            interestKind,
            interestUserHandle,
            sortBy,
        });
        if (next.toString() !== searchParams.toString()) {
            setSearchParams(next, { replace: true });
        }
    }, [activeTagIds, endDate, interestKind, interestSource, interestUserHandle, searchParams, setSearchParams, sortBy, startDate, viewMode]);

    // Events query source: Explorer pulls the date/interest-filtered set once
    // and applies the active area + tag filters client-side. The live map
    // viewport only classifies events as on-map/off-map; it no longer hides
    // matching events from the Explorer list or subsequent map refits.
    const initialLoadDone = useRef(false);
    const [visibleRange, setVisibleRange] = useState<{ start: Date; end: Date } | null>(null);
    useEffect(() => {
        if (!initialLoadDone.current) setLoading(true);
        let params: { startDate?: string; endDate?: string; area?: PreferredAreaPayload | null; interestSource?: 'follows' | 'friends'; interestKind?: 'any' | 'going' | 'saved'; interestUserHandle?: string } | undefined;
        const interestActive = interestSource !== null || !!interestUserHandle;
        if (viewMode === 'explorer') {
            // No ``area`` here on purpose — we pull the full date/interest set
            // and apply the active area locally. That keeps panning instant,
            // while semantic filters (tags/following) can still refit to all
            // matching events in the active/default area.
            params = {
                startDate,
                endDate,
                interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
                interestKind: interestActive ? interestKind : undefined,
                interestUserHandle: interestUserHandle ?? undefined,
            };
        } else if (visibleRange) {
            params = {
                startDate: formatDate(visibleRange.start),
                endDate: formatDate(visibleRange.end),
                interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
                interestKind: interestActive ? interestKind : undefined,
                interestUserHandle: interestUserHandle ?? undefined,
            };
        } else {
            // Calendar mode initial load: use same default as explorer
            params = {
                startDate,
                endDate,
                interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
                interestKind: interestActive ? interestKind : undefined,
                interestUserHandle: interestUserHandle ?? undefined,
            };
        }
        const tagParams = params?.startDate || params?.endDate ? params : undefined;
        Promise.all([fetchEvents(params), fetchSettings(), fetchTagGroups(tagParams)])
            .then(([evts, settings, groups]) => {
                // Invalidate cached attendance summaries for the events we just
                // (re)fetched so visible cards re-pull fresh avatars + counts
                // when filters change — mirrors page-refresh behavior without
                // dropping cache for events not in the new result.
                invalidateAttendanceSummaries(evts.map((e) => e.event_id));
                setEvents(evts);
                setSinceDate(settings.since_date);
                setTagGroups(groups);
            })
            .catch((e) => setError(e.message))
            .finally(() => {
                setLoading(false);
                initialLoadDone.current = true;
            });
    }, [viewMode, startDate, endDate, visibleRange, interestSource, interestKind, interestUserHandle]);

    const handleDateRangeChange = useCallback((start: string, end: string) => {
        setStartDate(start);
        setEndDate(end);
        bumpAutoFit();
    }, [bumpAutoFit]);

    const handleToggleTag = useCallback((tagId: number) => {
        userTouchedTagsRef.current = true;
        bumpAutoFit();
        setActiveTagIds((prev) => {
            const next = new Set(prev);
            if (next.has(tagId)) {
                next.delete(tagId);
                return next;
            }
            // Enforce single-select for groups where allow_multiple === false:
            // adding this tag deselects any sibling tags from the same group.
            const group = tagGroups.find((g) => g.tags.some((t) => t.id === tagId));
            if (group && group.allow_multiple === false) {
                const siblingIds = new Set(group.tags.map((t) => t.id));
                for (const id of Array.from(next)) {
                    if (siblingIds.has(id)) next.delete(id);
                }
            }
            next.add(tagId);
            return next;
        });
    }, [tagGroups]);

    const handleClearTags = useCallback(() => {
        userTouchedTagsRef.current = true;
        bumpAutoFit();
        setActiveTagIds(new Set());
    }, [bumpAutoFit]);

    // Extend the explorer's end date through the next future batch that has
    // matches under the current filters. Wired into ``EventListPanel`` so
    // users hitting the end of the current period can pull in the next useful
    // chunk without manually guessing date presets. Cleared by any subsequent
    // preset/date change.
    const [nextAvailableEventBatch, setNextAvailableEventBatch] = useState<FutureEventBatch | null | undefined>(undefined);
    const [extendingPeriod, setExtendingPeriod] = useState(false);
    const handleExtendPeriod = useCallback(() => {
        if (!nextAvailableEventBatch) return;
        setExtendingPeriod(true);
        setEndDate(nextAvailableEventBatch.endDate);
        bumpAutoFit();
        // ``loading`` flips back to false in the events fetch effect; mirror
        // it onto ``extendingPeriod`` via a microtask so the button shows a
        // brief "Loading…" state. A dedicated flag avoids leaking the
        // global loading state into the list-only CTA.
        setTimeout(() => setExtendingPeriod(false), 0);
    }, [bumpAutoFit, nextAvailableEventBatch]);

    // Clear every active filter back to the explorer's defaults. Wired into
    // the empty-state CTA so a user who over-filtered into "0 events" can
    // recover in one tap without hunting down individual chips.
    const handleClearAllFilters = useCallback(() => {
        const defaults = defaultExplorerDateRange();
        userTouchedTagsRef.current = true;
        setActiveTagIds(new Set());
        setInterestSource(null);
        setInterestKind('any');
        setInterestUserHandle(null);
        setStartDate(defaults.startDate);
        setEndDate(defaults.endDate);
        setAreaSessionOverride(null);
        bumpAutoFit();
    }, [bumpAutoFit]);

    // Remove a single tag from the active set (wired into SummaryBar chip ×).
    const handleRemoveTag = useCallback((tagId: number) => {
        userTouchedTagsRef.current = true;
        bumpAutoFit();
        setActiveTagIds((prev) => {
            if (!prev.has(tagId)) return prev;
            const next = new Set(prev);
            next.delete(tagId);
            return next;
        });
    }, [bumpAutoFit]);

    // Clear the follows/friends interest filter from the SummaryBar chip ×.
    const handleClearInterest = useCallback(() => {
        setInterestSource(null);
        setInterestKind('any');
        setInterestUserHandle(null);
    }, []);

    const handleClearCalendarFilters = useCallback(() => {
        userTouchedTagsRef.current = true;
        setActiveTagIds(new Set());
        setInterestSource(null);
        setInterestKind('any');
        setInterestUserHandle(null);
        bumpAutoFit();
    }, [bumpAutoFit]);

    // Reset any area session override (returns to saved prefs / default).
    const handleClearAreaOverride = useCallback(() => {
        setAreaSessionOverride(null);
        bumpAutoFit();
    }, [bumpAutoFit]);

    // Mobile-only FilterSheet open state. The sheet wraps the same controls
    // rendered inline on desktop so the landing page isn't crushed by a
    // tall filter stack on phones. State stays lifted in this component so
    // closing/opening the sheet doesn't reset anything.
    const [filterSheetOpen, setFilterSheetOpen] = useState(false);
    const defaultDateRange = useMemo(() => defaultExplorerDateRange(), []);
    const dateRangeDiffers =
        startDate !== defaultDateRange.startDate || endDate !== defaultDateRange.endDate;
    const activeFilterCount =
        activeTagIds.size
        + (interestSource ? 1 : 0)
        + (interestUserHandle ? 1 : 0)
        + (areaSessionOverride ? 1 : 0)
        + (dateRangeDiffers ? 1 : 0);
    const calendarActiveFilterCount = activeTagIds.size
        + (interestSource ? 1 : 0)
        + (interestUserHandle ? 1 : 0);

    // Map fullscreen toggle (mobile only — desktop layout already gives the
    // map a tall column). The map container picks up ``fixed inset-0`` when
    // active so users can scan markers without the URL bar / filters
    // eating screen height. Leaflet's existing ResizeObserver handles
    // invalidateSize after the class flip.
    const [mapFullscreen, setMapFullscreen] = useState(false);
    const mobileExplorerTopSummaryRef = useRef<HTMLDivElement | null>(null);
    const [showFloatingMobileExplorerSummary, setShowFloatingMobileExplorerSummary] = useState(false);

    useEffect(() => {
        if (isDesktop || viewMode !== 'explorer') {
            setShowFloatingMobileExplorerSummary(false);
            return;
        }
        const summaryEl = mobileExplorerTopSummaryRef.current;
        const scrollRoot = summaryEl?.closest('main');
        if (!summaryEl || !scrollRoot) {
            setShowFloatingMobileExplorerSummary(false);
            return;
        }

        const update = () => {
            const summaryRect = summaryEl.getBoundingClientRect();
            const rootRect = scrollRoot.getBoundingClientRect();
            setShowFloatingMobileExplorerSummary(summaryRect.bottom <= rootRect.top + 1);
        };

        update();
        scrollRoot.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        return () => {
            scrollRoot.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
        };
    }, [isDesktop, viewMode]);

    // Commit the current map viewport as the effective area filter. Paired
    // with the "Search this area" pill that appears after the user pans
    // the map; the pill disappears once committed because ``userMapBounds``
    // is cleared below.
    const handleSearchThisArea = useCallback(() => {
        if (!userMapBounds) return;
        const area: PreferredAreaPayload = {
            label: 'Map view',
            min_lat: userMapBounds.south,
            max_lat: userMapBounds.north,
            min_lng: userMapBounds.west,
            max_lng: userMapBounds.east,
        };
        setAreaSessionOverride({ kind: 'preset', area: clampArea(area) });
        setUserMapBounds(null);
        bumpAutoFit();
    }, [userMapBounds, bumpAutoFit]);

    const areaScopedEvents = useMemo(() => {
        if (viewMode !== 'explorer' || !effectiveArea) return events;
        const bounds = areaToMapBounds(effectiveArea);
        return events.filter((event) => eventMatchesBounds(event, bounds));
    }, [events, effectiveArea, viewMode]);

    const filteredEvents = useMemo(
        () => filterEventsByTags(events, activeTagIds, tagGroups),
        [events, activeTagIds, tagGroups],
    );

    const explorerMatchingEvents = useMemo(
        () => filterEventsByTags(areaScopedEvents, activeTagIds, tagGroups),
        [areaScopedEvents, activeTagIds, tagGroups],
    );

    useEffect(() => {
        if (viewMode !== 'explorer') {
            return;
        }
        const currentEnd = new Date(endDate);
        if (Number.isNaN(currentEnd.getTime())) {
            setNextAvailableEventBatch(null);
            return;
        }
        const interestActive = interestSource !== null || !!interestUserHandle;
        let cancelled = false;
        setNextAvailableEventBatch(undefined);
        const findNextBatch = async () => {
            let cursor = new Date(currentEnd);
            cursor.setDate(cursor.getDate() + 1);
            for (let i = 0; i < 8; i += 1) {
                const windowStart = new Date(cursor);
                const windowEnd = new Date(windowStart);
                windowEnd.setMonth(windowEnd.getMonth() + 3);
                const evts = await fetchEvents({
                    startDate: formatDate(windowStart),
                    endDate: formatDate(windowEnd),
                    interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
                    interestKind: interestActive ? interestKind : undefined,
                    interestUserHandle: interestUserHandle ?? undefined,
                });
                if (cancelled) return;
                const areaFiltered = effectiveArea
                    ? evts.filter((event) => eventMatchesBounds(event, areaToMapBounds(effectiveArea)))
                    : evts;
                const matching = filterEventsByTags(areaFiltered, activeTagIds, tagGroups);
                if (matching.length > 0) {
                    setNextAvailableEventBatch({
                        endDate: formatDate(windowEnd),
                        matchingCount: matching.length,
                    });
                    return;
                }
                cursor = new Date(windowEnd);
                cursor.setDate(cursor.getDate() + 1);
            }
            setNextAvailableEventBatch(null);
        };
        findNextBatch().catch(() => {
            if (!cancelled) setNextAvailableEventBatch(null);
        });
        return () => {
            cancelled = true;
        };
    }, [viewMode, endDate, interestSource, interestKind, interestUserHandle, effectiveArea, activeTagIds, tagGroups]);

    const selectedExplorerMapEvent = useMemo(
        () => explorerMatchingEvents.find((event) => event.event_id === selectedExplorerMapEventId) ?? null,
        [explorerMatchingEvents, selectedExplorerMapEventId],
    );

    const explorerAllViewCounts = useMemo(
        () => explorerMatchingEvents.map((event) => event.popularity_score ?? 0),
        [explorerMatchingEvents],
    );

    useEffect(() => {
        if (!selectedExplorerMapEventId) return;
        if (viewMode !== 'explorer' || isDesktop || !selectedExplorerMapEvent) {
            setSelectedExplorerMapEventId(null);
        }
    }, [isDesktop, selectedExplorerMapEvent, selectedExplorerMapEventId, viewMode]);

    // Disjunctive facet counts.
    //
    // Filter semantics (must match `filterEventsByTags` above):
    //   - Within a group: OR (event matches ANY selected tag in that group)
    //   - Across groups: AND (every group with a selection must be satisfied)
    //
    // For each tag T in group G, the displayed count is the number of events
    // that would match if the user *also* selected T — i.e., satisfying all
    // OTHER groups' selections, plus containing T. Selections within G itself
    // are intentionally ignored so siblings in a multi-select group don't
    // suppress each other's counts (Algolia / Amazon convention).
    const tagCountMap = useMemo(() => {
        const map = new Map<number, number>();
        if (!tagGroups.length) return map;

        const tagToGroupSlug = new Map<number, string>();
        for (const g of tagGroups) {
            for (const t of g.tags) tagToGroupSlug.set(t.id, g.slug);
        }

        // Active tag IDs grouped by their group slug.
        const activeByGroup = new Map<string, number[]>();
        for (const id of activeTagIds) {
            const slug = tagToGroupSlug.get(id);
            if (!slug) continue;
            const arr = activeByGroup.get(slug);
            if (arr) arr.push(id);
            else activeByGroup.set(slug, [id]);
        }

        const countSourceEvents = viewMode === 'explorer' ? areaScopedEvents : events;
        const eventTagSets = countSourceEvents.map((e) => new Set((e.tags ?? []).map((t) => t.id)));

        for (const g of tagGroups) {
            // Each entry is one OTHER group's selected IDs; event must contain
            // at least one ID from EACH such entry (OR within group, AND across).
            const otherGroupBuckets: number[][] = [];
            for (const [slug, ids] of activeByGroup) {
                if (slug === g.slug) continue;
                otherGroupBuckets.push(ids);
            }
            for (const t of g.tags) {
                let count = 0;
                for (const tagSet of eventTagSets) {
                    if (!tagSet.has(t.id)) continue;
                    let ok = true;
                    for (const bucket of otherGroupBuckets) {
                        if (!bucket.some((id) => tagSet.has(id))) { ok = false; break; }
                    }
                    if (ok) count++;
                }
                map.set(t.id, count);
            }
        }
        return map;
    }, [events, areaScopedEvents, viewMode, tagGroups, activeTagIds]);

    const handleDatesChange = useCallback((start: Date, end: Date) => {
        setVisibleRange((prev) => {
            if (prev && prev.start.getTime() === start.getTime() && prev.end.getTime() === end.getTime()) {
                return prev;
            }
            return { start, end };
        });
    }, []);

    const calendarVisibleEvents = useMemo(() => {
        if (!visibleRange) return filteredEvents;
        return filteredEvents.filter((e) => {
            const eventStart = new Date(e.start);
            const eventEnd = new Date(e.end || e.start);
            return eventEnd >= visibleRange.start && eventStart < visibleRange.end;
        });
    }, [filteredEvents, visibleRange]);

    const calendarSummaryRange = useMemo(() => {
        if (!visibleRange) return { startDate, endDate };
        const endInclusive = new Date(visibleRange.end.getTime() - 24 * 60 * 60 * 1000);
        return {
            startDate: formatDate(visibleRange.start),
            endDate: formatDate(endInclusive),
        };
    }, [endDate, startDate, visibleRange]);

    const handleEventClick = useCallback((evt: CalendarEvent, clickRect?: DOMRect) => {
        if (viewMode === 'explorer') {
            // Navigate to the event detail page
            navigate(`/event/${evt.event_id}`);
        } else {
            setSelectedEventRect(clickRect ?? null);
            setSelectedEventSource('calendar-modal');
            setSelectedEvent(evt);
        }
    }, [viewMode, navigate]);

    // Calendar-mode map marker click — fires its own trackView (no double-fire with Calendar grid)
    const handleCalMapEventClick = useCallback((evt: CalendarEvent) => {
        trackView(evt.event_id, 'calendar-map');
        setSelectedEventRect(null);
        setSelectedEventSource('calendar-map-modal');
        setSelectedEvent(evt);
    }, []);

    // Explorer list panel click — carries source through URL query param
    const handleExplorerListEventClick = useCallback((evt: CalendarEvent) => {
        markSeen(evt.event_id);
        navigate(`/event/${evt.event_id}?src=explorer-list`);
    }, [navigate, markSeen]);

    // Explorer map marker click — carries source through URL query param
    const handleExplorerMapEventClick = useCallback((evt: CalendarEvent) => {
        markSeen(evt.event_id);
        navigate(`/event/${evt.event_id}?src=explorer-map`);
    }, [navigate, markSeen]);

    const handleExplorerMapMarkerSelect = useCallback((evt: CalendarEvent) => {
        setSelectedExplorerMapEventId(evt.event_id);
        setHoveredEventId(evt.event_id);
    }, []);

    const handleCloseExplorerMapSelection = useCallback(() => {
        if (selectedExplorerMapEventId && hoveredEventId === selectedExplorerMapEventId) setHoveredEventId(null);
        setSelectedExplorerMapEventId(null);
    }, [hoveredEventId, selectedExplorerMapEventId]);

    const handleCloseModal = useCallback(() => {
        setSelectedEventRect(null);
        setSelectedEvent(null);
    }, []);

    const handleEditEvent = useCallback((evt: CalendarEvent) => {
        setSelectedEventRect(null);
        setSelectedEvent(null);
        setEditingEventId(evt.event_id);
    }, []);

    const handleCloseEdit = useCallback(() => {
        setEditingEventId(null);
        // Refresh events list so any admin edits propagate to other surfaces.
        const interestActive = interestSource !== null || !!interestUserHandle;
        const params = {
            ...(viewMode === 'explorer'
                ? { startDate, endDate }
                : visibleRange
                    ? { startDate: formatDate(visibleRange.start), endDate: formatDate(visibleRange.end) }
                    : { startDate, endDate }),
            interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
            interestKind: interestActive ? interestKind : undefined,
            interestUserHandle: interestUserHandle ?? undefined,
        };
        fetchEvents(params).then(setEvents).catch(() => { });
    }, [viewMode, startDate, endDate, visibleRange, interestKind, interestSource, interestUserHandle]);

    const handleBoundsChange = useCallback((bounds: MapBounds, userDriven: boolean) => {
        setMapBounds(bounds);
        if (userDriven) setUserMapBounds(bounds);
    }, []);

    const handleCalBoundsChange = useCallback((bounds: MapBounds) => {
        setCalMapBounds(bounds);
    }, []);

    // Detect when the user's live map view (``mapBounds``) has drifted from
    // the active area filter (``effectiveArea``). Compares CENTERS plus
    // EXTENT (zoom proxy): edge-by-edge comparison would flag drift right
    // after a fit (Leaflet snaps to discrete zooms and pads to the
    // viewport's aspect ratio, so the visible bbox is always a bit wider
    // than requested). Center+extent catches both pans and zooms while
    // tolerating that aspect-ratio slack.
    const mapDriftsFromArea = useMemo(() => {
        if (!mapBounds) return false;
        if (!effectiveArea) return true; // "show all" mode — any view differs
        const areaCenterLat = (effectiveArea.min_lat + effectiveArea.max_lat) / 2;
        const areaCenterLng = (effectiveArea.min_lng + effectiveArea.max_lng) / 2;
        const mapCenterLat = (mapBounds.south + mapBounds.north) / 2;
        const mapCenterLng = (mapBounds.west + mapBounds.east) / 2;
        const areaLatExtent = effectiveArea.max_lat - effectiveArea.min_lat;
        const areaLngExtent = effectiveArea.max_lng - effectiveArea.min_lng;
        const mapLatExtent = mapBounds.north - mapBounds.south;
        const mapLngExtent = mapBounds.east - mapBounds.west;
        // Center drift threshold: 25% of the area extent (min 1°).
        const latThreshold = Math.max(1, areaLatExtent * 0.25);
        const lngThreshold = Math.max(1, areaLngExtent * 0.25);
        if (
            Math.abs(mapCenterLat - areaCenterLat) > latThreshold ||
            Math.abs(mapCenterLng - areaCenterLng) > lngThreshold
        ) {
            return true;
        }
        // Zoom drift: visible extent differs from area extent by more than
        // 50% (smaller → user zoomed in; much larger → user zoomed out).
        // Uses the larger axis to pick up the dominant change.
        const latRatio = mapLatExtent / Math.max(0.01, areaLatExtent);
        const lngRatio = mapLngExtent / Math.max(0.01, areaLngExtent);
        if (latRatio < 0.5 || latRatio > 1.5 || lngRatio < 0.5 || lngRatio > 1.5) {
            return true;
        }
        return false;
    }, [mapBounds, effectiveArea]);

    // Set of event IDs not visible on the calendar-mode map
    const offMapEventIds = useMemo(() => {
        if (!calMapBounds || !showCalendarMap) return new Set<string>();
        return new Set(
            calendarVisibleEvents
                .filter((e) => {
                    if (e.latitude == null || e.longitude == null) return true;
                    return !(
                        e.latitude >= calMapBounds.south &&
                        e.latitude <= calMapBounds.north &&
                        e.longitude >= calMapBounds.west &&
                        e.longitude <= calMapBounds.east
                    );
                })
                .map((e) => e.event_id),
        );
    }, [calendarVisibleEvents, calMapBounds, showCalendarMap]);

    // Calendar ref + navigation (FC is always mounted in calendar mode)
    const calendarRef = useRef<FullCalendar>(null);

    const handleCalPrev = useCallback(() => calendarRef.current?.getApi().prev(), []);
    const handleCalNext = useCallback(() => calendarRef.current?.getApi().next(), []);
    const handleCalToday = useCallback(() => calendarRef.current?.getApi().today(), []);

    const calendarTitle = useMemo(() => {
        if (!visibleRange) return '';
        const spanDays = (visibleRange.end.getTime() - visibleRange.start.getTime()) / (1000 * 60 * 60 * 24);
        // Month view spans ~5-6 weeks (35-42 days). 3-week view spans 21 days.
        if (spanDays <= 28) {
            const start = visibleRange.start;
            // FullCalendar's range end is exclusive; subtract one day for display.
            const endInclusive = new Date(visibleRange.end.getTime() - 24 * 60 * 60 * 1000);
            const sameYear = start.getFullYear() === endInclusive.getFullYear();
            const sameMonth = sameYear && start.getMonth() === endInclusive.getMonth();
            const startStr = start.toLocaleDateString('en-US', sameMonth
                ? { month: 'short', day: 'numeric' }
                : { month: 'short', day: 'numeric' });
            const endStr = endInclusive.toLocaleDateString('en-US', sameYear
                ? { month: sameMonth ? undefined : 'short', day: 'numeric' }
                : { month: 'short', day: 'numeric', year: 'numeric' });
            const yearSuffix = sameYear ? `, ${endInclusive.getFullYear()}` : '';
            return `${startStr} – ${endStr}${yearSuffix}`;
        }
        const mid = new Date((visibleRange.start.getTime() + visibleRange.end.getTime()) / 2);
        return mid.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    }, [visibleRange]);

    // Shared filter controls JSX. Rendered inline in the desktop left
    // column AND inside the mobile FilterSheet. The components are all
    // controlled (state lives in this component) so mounting twice is safe;
    // the desktop instance is CSS-hidden on mobile while the sheet is
    // closed.
    const tagFilters = tagGroups.length > 0 ? (
        <TagFilterPills
            tagGroups={tagGroups}
            activeTagIds={activeTagIds}
            onToggle={handleToggleTag}
            onClear={handleClearTags}
            countOverrides={tagCountMap}
            sortMode={tagSortMode}
            trailingSlot={tagsDifferFromPrefs ? (
                <button
                    type="button"
                    onClick={handleSaveTagsAsDefault}
                    disabled={savingDefaults}
                    className="ml-1 inline-flex items-center whitespace-nowrap text-[11px] text-slate-500 underline hover:text-slate-700 hover:no-underline disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="save-tags-as-default"
                >
                    {savingDefaults ? 'Saving…' : 'current as default'}
                </button>
            ) : undefined}
        />
    ) : null;

    const renderInterestFilters = (surface: 'inline' | 'sheet' = 'inline') => (
        <InterestFilterChips
            signedIn={!!user}
            surface={surface}
            interestSource={interestSource}
            interestKind={interestKind}
            interestUserHandle={interestUserHandle}
            onChange={(next) => {
                bumpAutoFit();
                if (Object.prototype.hasOwnProperty.call(next, 'source')) {
                    setInterestSource(next.source ?? null);
                    if (next.source === null) setInterestUserHandle(null);
                }
                if (Object.prototype.hasOwnProperty.call(next, 'kind')) {
                    setInterestKind(next.kind!);
                }
                if (Object.prototype.hasOwnProperty.call(next, 'userHandle')) {
                    setInterestUserHandle(next.userHandle ?? null);
                    if (next.userHandle && interestSource === null) {
                        setInterestSource('follows');
                    }
                }
            }}
        />
    );

    const renderFilterControls = (surface: 'inline' | 'sheet' = 'inline') => {
        if (surface === 'sheet') {
            return (
                <>
                    <section className="filter-sheet-section" aria-labelledby="filter-sheet-period-heading">
                        <h3 id="filter-sheet-period-heading" className="filter-sheet-section-title">Period</h3>
                        <DateRangePicker
                            startDate={startDate}
                            endDate={endDate}
                            onChange={handleDateRangeChange}
                        />
                    </section>
                    {tagFilters && (
                        <section className="filter-sheet-section" aria-labelledby="filter-sheet-tags-heading">
                            <h3 id="filter-sheet-tags-heading" className="filter-sheet-section-title">Tags</h3>
                            {tagFilters}
                        </section>
                    )}
                    <section className="filter-sheet-section" aria-labelledby="filter-sheet-following-heading">
                        <h3 id="filter-sheet-following-heading" className="filter-sheet-section-title">Following</h3>
                        {renderInterestFilters(surface)}
                    </section>
                </>
            );
        }

        return (
            <>
                <DateRangePicker
                    startDate={startDate}
                    endDate={endDate}
                    onChange={handleDateRangeChange}
                />
                {tagFilters}
                {renderInterestFilters(surface)}
            </>
        );
    };

    const renderCalendarFilterControls = () => (
        <>
            {tagGroups.length > 0 && (
                <TagFilterPills
                    tagGroups={tagGroups}
                    activeTagIds={activeTagIds}
                    onToggle={handleToggleTag}
                    onClear={handleClearTags}
                    countOverrides={tagCountMap}
                    sortMode={tagSortMode}
                    trailingSlot={tagsDifferFromPrefs ? (
                        <button
                            type="button"
                            onClick={handleSaveTagsAsDefault}
                            disabled={savingDefaults}
                            className="ml-1 inline-flex items-center whitespace-nowrap text-[11px] text-slate-500 underline hover:text-slate-700 hover:no-underline disabled:opacity-50 disabled:cursor-not-allowed"
                            data-testid="save-tags-as-default-calendar"
                        >
                            {savingDefaults ? 'Saving…' : 'current as default'}
                        </button>
                    ) : undefined}
                />
            )}
            <InterestFilterChips
                signedIn={!!user}
                surface="sheet"
                interestSource={interestSource}
                interestKind={interestKind}
                interestUserHandle={interestUserHandle}
                onChange={(next) => {
                    bumpAutoFit();
                    if (Object.prototype.hasOwnProperty.call(next, 'source')) {
                        setInterestSource(next.source ?? null);
                        if (next.source === null) setInterestUserHandle(null);
                    }
                    if (Object.prototype.hasOwnProperty.call(next, 'kind')) {
                        setInterestKind(next.kind!);
                    }
                    if (Object.prototype.hasOwnProperty.call(next, 'userHandle')) {
                        setInterestUserHandle(next.userHandle ?? null);
                        if (next.userHandle && interestSource === null) {
                            setInterestSource('follows');
                        }
                    }
                }}
            />
        </>
    );

    const renderExplorerMobileSummaryBar = (className?: string) => (
        <SummaryBar
            className={className}
            totalCount={explorerMatchingEvents.length}
            visibleCount={explorerMatchingEvents.length}
            startDate={startDate}
            endDate={endDate}
            areaLabel={
                areaChipState.kind === 'map-view' ? 'Current map view'
                    : areaChipState.kind === 'show-all' ? 'Worldwide'
                        : areaChipState.label
            }
            areaKind={areaChipState.kind}
            areaIsDefault={areaChipState.kind === 'default' && !areaSessionOverride}
            onClearArea={handleClearAreaOverride}
            activeTagIds={activeTagIds}
            tagGroups={tagGroups}
            onRemoveTag={handleRemoveTag}
            interestSource={interestSource}
            interestKind={interestKind}
            interestUserHandle={interestUserHandle}
            onClearInterest={handleClearInterest}
            onClearAll={handleClearAllFilters}
            loading={loading}
            onOpenFilters={() => setFilterSheetOpen(true)}
            activeFilterCount={activeFilterCount}
        />
    );

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-2 sm:py-4">
                {!loading && !error && (
                    <div className="mb-3 sm:mb-4 flex flex-col gap-2">
                        <div className="flex items-center gap-3">
                            <div className="flex gap-1 bg-slate-200 p-1 shrink-0 w-fit">
                                <Link
                                    to="/"
                                    className={`px-3 py-1 text-sm transition ${viewMode === 'explorer' ? 'bg-white text-slate-900 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    Explorer
                                </Link>
                                <Link
                                    to="/calendar"
                                    className={`px-3 py-1 text-sm transition ${viewMode === 'calendar' ? 'bg-white text-slate-900 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    Calendar
                                </Link>
                            </div>
                            <div className="flex gap-1 bg-slate-200 p-1 shrink-0 w-fit">
                                <MineButton />
                                <FollowsButton />
                                <button
                                    onClick={() => setShowSuggestModal(true)}
                                    className="hidden sm:inline-flex px-3 py-1 text-sm transition bg-white text-slate-900 font-medium shadow-sm hover:bg-slate-50"
                                >
                                    <span className="sm:hidden">Submit</span>
                                    <span className="hidden sm:inline">Submit Event</span>
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {loading && (
                    <p className="text-center text-slate-400">Loading events…</p>
                )}
                {error && (
                    <p className="text-center text-red-500">Error: {error}</p>
                )}
                {!loading && !error && viewMode === 'explorer' && (
                    <>
                        {showFloatingMobileExplorerSummary && (
                            <div className="fixed left-4 right-4 top-10 z-[7000] lg:hidden">
                                {renderExplorerMobileSummaryBar('shadow-md')}
                            </div>
                        )}
                        <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 lg:items-start">
                            {/* Left column: filters + list */}
                            <div className="order-1 lg:order-1 lg:w-[350px] lg:shrink-0 flex flex-col gap-3 lg:gap-4 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6">
                                {/* Mobile-only filter strip. Doubles as the
                                "open FilterSheet" affordance AND the
                                applied-filters summary so users see what's
                                narrowing the result set without an extra
                                stacked block. */}
                                <div ref={mobileExplorerTopSummaryRef} className="lg:hidden">
                                    {renderExplorerMobileSummaryBar()}
                                </div>
                                {/* Desktop inline filter stack. Hidden on
                                mobile (rendered inside FilterSheet instead). */}
                                <div className="hidden lg:flex lg:flex-col lg:gap-4">
                                    {renderFilterControls()}
                                </div>
                                {/* Event list: hidden on mobile until after map, fills remaining height on desktop */}
                                <div className="hidden lg:flex lg:flex-col lg:flex-1 lg:min-h-0 lg:overflow-hidden">
                                    <SummaryBar
                                        totalCount={explorerMatchingEvents.length}
                                        visibleCount={explorerMatchingEvents.length}
                                        startDate={startDate}
                                        endDate={endDate}
                                        areaLabel={
                                            areaChipState.kind === 'map-view' ? 'Current map view'
                                                : areaChipState.kind === 'show-all' ? 'Worldwide'
                                                    : areaChipState.label
                                        }
                                        areaKind={areaChipState.kind}
                                        areaIsDefault={areaChipState.kind === 'default' && !areaSessionOverride}
                                        onClearArea={handleClearAreaOverride}
                                        activeTagIds={activeTagIds}
                                        tagGroups={tagGroups}
                                        onRemoveTag={handleRemoveTag}
                                        interestSource={interestSource}
                                        interestKind={interestKind}
                                        interestUserHandle={interestUserHandle}
                                        onClearInterest={handleClearInterest}
                                        onClearAll={handleClearAllFilters}
                                        loading={loading}
                                    />
                                    <div className="flex-1 min-h-0 overflow-hidden">
                                        <EventListPanel
                                            events={explorerMatchingEvents}
                                            mapBounds={mapBounds}
                                            onEventClick={handleExplorerListEventClick}
                                            showPrices={showPrices}
                                            showPopularity={showPopularity}
                                            popularityThreshold={popularityThreshold}
                                            sortBy={sortBy}
                                            onSortChange={setSortBy}
                                            hoveredEventId={hoveredEventId}
                                            onEventHover={handleEventHover}
                                            onSuggestEvent={() => setShowSuggestModal(true)}
                                            newEnabled={unseenStateEnabled}
                                            newEventIds={newEventIds}
                                            onExtendPeriod={handleExtendPeriod}
                                            onClearFilters={handleClearAllFilters}
                                            extendingPeriod={extendingPeriod}
                                            scopeTotalCount={explorerMatchingEvents.length}
                                            nextPeriodEventCount={nextAvailableEventBatch === undefined ? undefined : nextAvailableEventBatch?.matchingCount ?? 0}
                                            gateMoreEventsForAnonymous
                                        />
                                    </div>
                                </div>
                            </div>
                            {/* Map column: map + default-location bar stacked.
                            On mobile this is order-2 (between left filters
                            and event list). On desktop the column is sticky
                            and fills available height; the bar is shrink-0
                            so it doesn't get clipped. */}
                            <div className="order-2 lg:order-2 lg:flex-1 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6 flex flex-col gap-1.5 sm:gap-2 min-w-0">
                                <div
                                    className={
                                        mapFullscreen
                                            ? 'explorer-map-shell fixed inset-0 z-[8000] bg-white overflow-hidden'
                                            : 'explorer-map-shell relative h-[270px] sm:h-[331px] lg:h-auto lg:flex-1 lg:min-h-0 overflow-hidden'
                                    }
                                    data-testid="explorer-map-shell"
                                    data-fullscreen={mapFullscreen ? 'true' : 'false'}
                                >
                                    <EventMap
                                        events={explorerMatchingEvents}
                                        onEventClick={handleExplorerMapEventClick}
                                        onBoundsChange={handleBoundsChange}
                                        hoveredEventId={hoveredEventId}
                                        onEventHover={handleEventHover}
                                        detailLinkSource="explorer-map"
                                        autoFitToken={mapAutoFitToken}
                                        flyToArea={flyToAreaBbox}
                                        flyToAreaToken={flyToAreaToken}
                                        initialArea={initialAreaRef.current}
                                        newEventIds={newEventIds}
                                        popularityThreshold={popularityThreshold}
                                        onMarkSeen={markSeen}
                                        disablePopups={!isDesktop}
                                        onMarkerSelect={!isDesktop ? handleExplorerMapMarkerSelect : undefined}
                                        showFollowingBadgeOverlay={mapFollowingBadgeOverlay}
                                        showTrendingOverlay={mapTrendingOverlay}
                                    />
                                    {selectedExplorerMapEvent && !isDesktop && (
                                        <div className="map-selected-event-card absolute inset-x-2 bottom-2 z-[700] lg:hidden border border-blue-100 bg-white shadow-lg" data-testid="explorer-map-selected-event">
                                            <button
                                                type="button"
                                                onClick={handleCloseExplorerMapSelection}
                                                className="absolute -top-7 right-0 z-[701] inline-flex h-6 w-6 items-center justify-center border border-blue-100 bg-white text-slate-500 shadow-sm hover:text-slate-700"
                                                aria-label="Close selected event"
                                            >
                                                ×
                                            </button>
                                            <EventListCard
                                                event={selectedExplorerMapEvent}
                                                mapBounds={mapBounds}
                                                onEventClick={handleExplorerMapEventClick}
                                                showPrices={showPrices}
                                                showPopularity={showPopularity && trendingEnabled}
                                                popularityThreshold={popularityThreshold}
                                                trendingTopN={trendingTopN}
                                                trendingTopPercent={trendingTopPercent}
                                                allViewCounts={explorerAllViewCounts}
                                                followingBadgeEnabled={followingBadgeEnabled}
                                                showRatings={!!showRatings}
                                                isSavedFlag={isSaved(selectedExplorerMapEvent.event_id)}
                                                isNew={unseenStateEnabled && newEventIds.has(selectedExplorerMapEvent.event_id)}
                                                onEventHover={handleEventHover}
                                            />
                                            <Link
                                                to={`/event/${selectedExplorerMapEvent.event_id}?src=explorer-map`}
                                                className="absolute bottom-2 right-2 z-[701] text-[11px] font-semibold text-blue-500 underline underline-offset-2 hover:text-blue-600 hover:no-underline"
                                            >
                                                Details
                                            </Link>
                                        </div>
                                    )}
                                    {/* Search-this-area pill. Appears when
                                    the user has panned/zoomed away from the
                                    current effective area filter; tapping it
                                    commits the live viewport as the area
                                    filter and clears the userMapBounds flag
                                    so the pill disappears. */}
                                    {userMapBounds && (
                                        <button
                                            type="button"
                                            onClick={handleSearchThisArea}
                                            className="absolute top-2 left-1/2 -translate-x-1/2 z-[702] inline-flex items-center gap-1 border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1.5 shadow-md transition"
                                            data-testid="map-search-this-area"
                                        >
                                            Search this area
                                        </button>
                                    )}
                                    {/* Fullscreen toggle. Mobile-first;
                                    rendered on desktop too but rarely
                                    needed there since the map column is
                                    already tall. */}
                                    <button
                                        type="button"
                                        onClick={() => setMapFullscreen((v) => !v)}
                                        aria-label={mapFullscreen ? 'Exit fullscreen map' : 'Open fullscreen map'}
                                        title={mapFullscreen ? 'Exit fullscreen' : 'Fullscreen map'}
                                        className="absolute top-2 right-2 z-[702] inline-flex h-8 w-8 items-center justify-center border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 shadow-sm transition"
                                        data-testid="map-fullscreen-toggle"
                                    >
                                        {mapFullscreen ? '×' : '⤢'}
                                    </button>
                                </div>
                                {/* Default-area bar: ONE bordered pill that
                                visually groups the chip label + worldwide /
                                reset toggle + save-as-default link, so the
                                user reads it as a single "this is the area
                                being applied, here's what you can do with
                                it" unit. */}
                                <div
                                    className="shrink-0 flex flex-col gap-1 px-1.5 sm:px-2 py-0.5 sm:py-1 border bg-slate-100 border-slate-200 text-slate-700 text-xs min-w-0"
                                    data-testid="area-default-bar"
                                >
                                    <div className="flex flex-wrap items-center gap-1 sm:gap-2 min-w-0">
                                        <AreaFilterChip state={areaChipState} />
                                        {/* Snap-back pill: fly the map to
                                            the configured default area
                                            (prefs.area when set, else the
                                            hardcoded Europe preset). Visible
                                            whenever the live map view has
                                            drifted from that default OR the
                                            user is in show-all mode — in
                                            both cases this is how they get
                                            back to "events I usually care
                                            about". Hidden when the chip
                                            already shows the default area
                                            and the map is on it (no drift). */}
                                        {(mapDriftsFromArea || areaChipState.kind === 'show-all') && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const target = prefs.area ?? DEFAULT_AREA_BBOX;
                                                    setAreaSessionOverride(null);
                                                    flyToArea(target);
                                                }}
                                                className="shrink-0 whitespace-nowrap px-1.5 py-px border border-slate-300 bg-white text-[11px] opacity-80 hover:opacity-100"
                                                title="Snap map back to your default area"
                                                data-testid="area-snap-default"
                                            >
                                                Default
                                            </button>
                                        )}
                                        {/* Quick-pick: switch to the hardcoded
                                        "Europe & nearby" preset. Hidden when
                                        the preset is already what's being
                                        applied AND the map is on it. */}
                                        {!(effectiveArea && isDefaultArea(effectiveArea) && !mapDriftsFromArea) && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setAreaSessionOverride({ kind: 'preset', area: DEFAULT_AREA_BBOX });
                                                    flyToArea(DEFAULT_AREA_BBOX);
                                                }}
                                                className="shrink-0 whitespace-nowrap px-1.5 py-px border border-slate-300 bg-white text-[11px] opacity-80 hover:opacity-100"
                                                title="Apply the Europe & nearby preset"
                                                data-testid="area-preset-europe"
                                            >
                                                Europe
                                            </button>
                                        )}
                                        {areaChipState.kind !== 'show-all' && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setAreaSessionOverride({ kind: 'show-all' });
                                                    flyToArea({ min_lat: -60, min_lng: -170, max_lat: 75, max_lng: 170, label: 'World' });
                                                }}
                                                className="shrink-0 whitespace-nowrap px-1.5 py-px border border-slate-300 bg-white text-[11px] opacity-80 hover:opacity-100"
                                                title="Show events worldwide"
                                                aria-label="Show events worldwide"
                                                data-testid="area-show-all"
                                            >
                                                🌐
                                            </button>
                                        )}
                                        {mapDriftsFromArea && !namingArea && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setAreaNameDraft(effectiveArea?.label ?? '');
                                                    setNamingArea(true);
                                                }}
                                                disabled={savingDefaults}
                                                className="shrink-0 whitespace-nowrap underline opacity-70 hover:opacity-100 hover:no-underline disabled:opacity-50 disabled:cursor-not-allowed"
                                                data-testid="save-location-as-default"
                                            >
                                                current as default
                                            </button>
                                        )}
                                        {savedDefaultsToast && (
                                            <span className="shrink-0" role="status">
                                                Saved.
                                            </span>
                                        )}

                                    </div>
                                    {/* Inline name-this-area form. Submitting
                                    persists prefs.area with the typed label;
                                    cancelling closes without saving. */}
                                    {namingArea && (
                                        <form
                                            className="flex flex-wrap items-center gap-2 min-w-0"
                                            data-testid="area-name-form"
                                            onSubmit={async (e) => {
                                                e.preventDefault();
                                                await handleSaveLocationAsDefault(areaNameDraft);
                                                setNamingArea(false);
                                            }}
                                        >
                                            <input
                                                type="text"
                                                value={areaNameDraft}
                                                onChange={(e) => setAreaNameDraft(e.target.value)}
                                                placeholder="Name this area (e.g. Berlin & around)"
                                                autoFocus
                                                maxLength={60}
                                                className="flex-1 min-w-0 px-2 py-1 border border-slate-300 bg-white text-xs"
                                                data-testid="area-name-input"
                                            />
                                            <button
                                                type="submit"
                                                disabled={savingDefaults}
                                                className="shrink-0 whitespace-nowrap px-2 py-1 bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                                data-testid="area-name-save"
                                            >
                                                {savingDefaults ? 'Saving…' : 'Save'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setNamingArea(false)}
                                                className="shrink-0 whitespace-nowrap underline opacity-70 hover:opacity-100 hover:no-underline"
                                                data-testid="area-name-cancel"
                                            >
                                                cancel
                                            </button>
                                        </form>
                                    )}
                                </div>
                            </div>
                            {/* Event list on mobile: order-3, hidden on desktop.
                            The top-of-map SummaryBar floats once it scrolls
                            away, so this section does not render a duplicate. */}
                            <div className="order-3 lg:hidden">
                                <EventListPanel
                                    events={explorerMatchingEvents}
                                    mapBounds={mapBounds}
                                    onEventClick={handleExplorerListEventClick}
                                    showPrices={showPrices}
                                    showPopularity={showPopularity}
                                    popularityThreshold={popularityThreshold}
                                    sortBy={sortBy}
                                    onSortChange={setSortBy}
                                    hoveredEventId={hoveredEventId}
                                    onEventHover={handleEventHover}
                                    onSuggestEvent={() => setShowSuggestModal(true)}
                                    newEnabled={unseenStateEnabled}
                                    newEventIds={newEventIds}
                                    scrollHighlightedIntoView={false}
                                    onExtendPeriod={handleExtendPeriod}
                                    onClearFilters={handleClearAllFilters}
                                    extendingPeriod={extendingPeriod}
                                    scopeTotalCount={explorerMatchingEvents.length}
                                    nextPeriodEventCount={nextAvailableEventBatch === undefined ? undefined : nextAvailableEventBatch?.matchingCount ?? 0}
                                    gateMoreEventsForAnonymous
                                />
                            </div>
                        </div>
                    </>
                )}
                {!loading && !error && viewMode === 'calendar' && (
                    <>
                        {/* Calendar toolbar: section toggles + month navigation */}
                        <div className="mb-4 flex items-center gap-4 flex-wrap">
                            <div className="flex gap-1 bg-slate-200 p-1 shrink-0">
                                <button
                                    className={`px-2.5 py-1 text-xs font-medium transition ${showCalendarGrid ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                    onClick={() => setShowCalendarGrid((v) => !v)}
                                >
                                    📅 Calendar
                                </button>
                                <button
                                    className={`px-2.5 py-1 text-xs font-medium transition ${showCalendarMap ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                    onClick={() => setShowCalendarMap((v) => !v)}
                                >
                                    📍 Map
                                </button>
                            </div>
                            <div className="flex items-center gap-1.5 sm:gap-2">
                                <div className="flex">
                                    <button className="px-2 py-1 text-sm border border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalPrev}>‹</button>
                                    <button className="px-2.5 py-1 text-sm border-y border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalToday}>today</button>
                                    <button className="px-2 py-1 text-sm border border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalNext}>›</button>
                                </div>
                                <h2 className="text-xs sm:text-sm font-semibold tracking-tight text-slate-800 whitespace-nowrap leading-none">{calendarTitle}</h2>
                            </div>
                            {isMobileViewport && (
                                <div className="flex gap-1 bg-slate-200 p-1 shrink-0 sm:hidden">
                                    <button
                                        className={`px-2 py-1 text-xs font-medium transition ${mobileCalendarView === '3week' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        onClick={() => setMobileCalendarView('3week')}
                                        aria-pressed={mobileCalendarView === '3week'}
                                    >
                                        3 wk
                                    </button>
                                    <button
                                        className={`px-2 py-1 text-xs font-medium transition ${mobileCalendarView === 'month' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        onClick={() => setMobileCalendarView('month')}
                                        aria-pressed={mobileCalendarView === 'month'}
                                    >
                                        Month
                                    </button>
                                </div>
                            )}
                        </div>
                        <div className="mb-4 sticky top-0 z-[20] shadow-sm">
                            <SummaryBar
                                totalCount={calendarVisibleEvents.length}
                                visibleCount={calendarVisibleEvents.length}
                                startDate={calendarSummaryRange.startDate}
                                endDate={calendarSummaryRange.endDate}
                                areaLabel={DEFAULT_AREA_LABEL}
                                areaKind="default"
                                areaIsDefault
                                activeTagIds={activeTagIds}
                                tagGroups={tagGroups}
                                onRemoveTag={handleRemoveTag}
                                interestSource={interestSource}
                                interestKind={interestKind}
                                interestUserHandle={interestUserHandle}
                                onClearInterest={handleClearInterest}
                                onClearAll={handleClearCalendarFilters}
                                loading={loading}
                                onOpenFilters={() => setFilterSheetOpen(true)}
                                activeFilterCount={calendarActiveFilterCount}
                            />
                        </div>
                        <div className="flex flex-col lg:flex-row gap-6">
                            {/* Calendar always mounted — CSS-hidden when toggled off */}
                            <div className={showCalendarGrid ? 'min-w-0 flex-1' : 'calendar-hide-grid h-0 overflow-hidden'}>
                                <Calendar
                                    ref={calendarRef}
                                    events={filteredEvents}
                                    sinceDate={sinceDate ?? undefined}
                                    onDatesChange={handleDatesChange}
                                    onEventClick={handleEventClick}
                                    hoveredEventId={hoveredEventId}
                                    onEventHover={handleEventHover}
                                    offMapEventIds={offMapEventIds}
                                    viewMode={calendarViewMode}
                                />
                            </div>
                            {showCalendarMap && (
                                <div className={showCalendarGrid
                                    ? 'h-[400px] lg:w-[420px] lg:shrink-0 lg:h-[calc(100vh-200px)] lg:sticky lg:top-6'
                                    : 'h-[70vh] w-full'
                                }>
                                    <EventMap
                                        key={String(showCalendarGrid)}
                                        events={calendarVisibleEvents}
                                        focusedEvent={selectedEvent}
                                        onEventClick={handleCalMapEventClick}
                                        onBoundsChange={handleCalBoundsChange}
                                        hoveredEventId={hoveredEventId}
                                        onEventHover={handleEventHover}
                                        detailLinkSource="calendar-map"
                                        newEventIds={newEventIds}
                                        popularityThreshold={popularityThreshold}
                                        onMarkSeen={markSeen}
                                    />
                                </div>
                            )}
                            {!showCalendarGrid && !showCalendarMap && (
                                <p className="text-center text-slate-400 py-12 w-full">Enable Calendar or Map above to view events.</p>
                            )}
                        </div>
                    </>
                )}
            </main>

            {/* Overlay modal — calendar mode mobile only */}
            {selectedEvent && viewMode === 'calendar' && !isDesktop && (
                <EventModal
                    event={selectedEvent}
                    onClose={handleCloseModal}
                    onEdit={user?.is_admin ? handleEditEvent : undefined}
                    source={selectedEventSource ?? undefined}
                />
            )}

            {selectedEvent && viewMode === 'calendar' && isDesktop && (
                <EventAnchoredDetailPanel
                    event={selectedEvent}
                    anchorRect={selectedEventRect}
                    onClose={handleCloseModal}
                    onEdit={user?.is_admin ? handleEditEvent : undefined}
                    source={selectedEventSource ?? undefined}
                />
            )}

            <AdminEventDetailPanel
                eventId={editingEventId}
                onClose={handleCloseEdit}
            />
            {showSuggestModal && (
                <SuggestEventModal onClose={() => setShowSuggestModal(false)} />
            )}
            <FilterSheet
                open={filterSheetOpen}
                onClose={() => setFilterSheetOpen(false)}
                onClearAll={viewMode === 'calendar' ? handleClearCalendarFilters : handleClearAllFilters}
                activeFilterCount={viewMode === 'calendar' ? calendarActiveFilterCount : activeFilterCount}
                matchingEventCount={viewMode === 'calendar' ? calendarVisibleEvents.length : explorerMatchingEvents.length}
            >
                {viewMode === 'calendar' ? renderCalendarFilterControls() : renderFilterControls('sheet')}
            </FilterSheet>
        </div>
    );
}

interface InterestFilterChange {
    source?: 'follows' | 'friends' | null;
    kind?: 'any' | 'going' | 'saved';
    userHandle?: string | null;
}

function InterestFilterChips({
    signedIn,
    surface = 'inline',
    interestSource,
    interestKind,
    interestUserHandle,
    onChange,
}: {
    signedIn: boolean;
    surface?: 'inline' | 'sheet';
    interestSource: 'follows' | 'friends' | null;
    interestKind: 'any' | 'going' | 'saved';
    interestUserHandle: string | null;
    onChange: (next: InterestFilterChange) => void;
}) {
    // Square corners, blue-500 for selected (matches TagFilterPills + UI
    // conventions). The component is purely presentational + a small
    // amount of local UI state for the picker popover.
    const chip = (active: boolean) =>
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-2 py-0.5 text-xs border transition sm:gap-1.5 sm:py-1 ' +
        (active
            ? 'bg-blue-500 border-blue-500 text-white'
            : 'bg-white border-slate-200 text-slate-600 hover:border-blue-500 hover:text-blue-500');
    // Anonymous users see the inline "Sign in to…" hint when they click
    // the Following pill (rather than the pill being disabled and the
    // hint only showing in the post-logout edge case where
    // interestSource had been left non-null).
    const [showAnonHint, setShowAnonHint] = useState(false);
    const pickerActive = signedIn
        ? interestSource !== null || !!interestUserHandle
        : showAnonHint;
    const [pickerOpen, setPickerOpen] = useState(false);
    const followingLabel = surface === 'sheet'
        ? (pickerActive ? null : 'Filter by following')
        : 'Following';
    return (
        <div className="flex flex-wrap items-center gap-1 sm:gap-2">

            <button
                type="button"
                onClick={() => {
                    if (signedIn) {
                        onChange({ source: interestSource === null ? 'follows' : null });
                    } else {
                        setShowAnonHint((v) => !v);
                    }
                }}
                className={chip(pickerActive)}
                aria-label={signedIn ? 'Show events from people you follow' : 'Sign in to filter by people you follow'}
                aria-pressed={pickerActive}
                title={signedIn ? 'Show events from people you follow' : 'Sign in to filter by people you follow'}
            >
                <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    className="h-3.5 w-3.5 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="7" cy="7" r="3" />
                    <path d="M2 17c0-2.8 2.2-5 5-5s5 2.2 5 5" />
                    <circle cx="14" cy="6" r="2.4" />
                    <path d="M13 12c2.8 0 5 2 5 5" />
                </svg>
                {followingLabel && <span>{followingLabel}</span>}
            </button>
            {/* Quick shortcut to the dedicated "From people I follow" calendar
            view. Revealed only when the Following filter is active so it
            stays out of the way until users opt into the follows context. */}
            {pickerActive && (
                <Link
                    to={signedIn ? '/my-calendar/subscriptions' : `/login?next=${encodeURIComponent('/my-calendar/subscriptions')}`}
                    data-testid="follows-shortcut"
                    aria-label="Open the calendar from people I follow"
                    title="Open the calendar from people I follow"
                    className="hidden sm:inline-flex items-center px-2 py-1 text-xs border border-slate-200 bg-white text-slate-600 hover:border-blue-500 hover:text-blue-500 transition"
                >
                    {/* Heroicons calendar outline */}
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-3.5 h-3.5" aria-hidden="true">
                        <rect x="2.75" y="4.25" width="14.5" height="13" rx="0" />
                        <path d="M2.75 8.25h14.5M6.5 2.75v3M13.5 2.75v3" strokeLinecap="round" />
                    </svg>
                </Link>
            )}
            {signedIn && pickerActive && (
                <>
                    {/* Scope pills: which graph to draw from. */}
                    <div className="flex shrink-0 gap-0.5 border border-slate-200 bg-white">
                        <button
                            type="button"
                            onClick={() => onChange({ source: 'follows' })}
                            className={
                                'px-1.5 py-0.5 text-[11px] transition sm:px-2 sm:py-1 sm:text-xs ' +
                                (interestSource === 'follows'
                                    ? 'bg-blue-500 text-white'
                                    : 'text-slate-600 hover:text-blue-500')
                            }
                            aria-label="Show all people you follow"
                            aria-pressed={interestSource === 'follows'}
                            title="Everyone you follow (one-way OK)"
                        >
                            All
                        </button>
                        <button
                            type="button"
                            onClick={() => onChange({ source: 'friends' })}
                            className={
                                'px-1.5 py-0.5 text-[11px] transition sm:px-2 sm:py-1 sm:text-xs ' +
                                (interestSource === 'friends'
                                    ? 'bg-blue-500 text-white'
                                    : 'text-slate-600 hover:text-blue-500')
                            }
                            aria-label="Show mutual friends only"
                            aria-pressed={interestSource === 'friends'}
                            title="Mutual followers only"
                        >
                            Friends
                        </button>
                    </div>
                    {/* Kind pills: which signal. */}
                    <div className="flex shrink-0 gap-0.5 border border-slate-200 bg-white">
                        {(['any', 'going', 'saved'] as const).map((k) => (
                            <button
                                key={k}
                                type="button"
                                onClick={() => onChange({ kind: k })}
                                className={
                                    'px-1.5 py-0.5 text-[11px] transition sm:px-2 sm:py-1 sm:text-xs ' +
                                    (interestKind === k
                                        ? 'bg-blue-500 text-white'
                                        : 'text-slate-600 hover:text-blue-500')
                                }
                                aria-label={k === 'any' ? 'Show any activity' : k === 'going' ? 'Show going activity' : 'Show saved activity'}
                                aria-pressed={interestKind === k}
                                title={k === 'any' ? 'Any activity' : k === 'going' ? 'Going activity' : 'Saved activity'}
                            >
                                {k === 'any' ? 'Any' : k === 'going' ? 'Going' : 'Saved'}
                            </button>
                        ))}
                    </div>
                    {/* Single-user narrow: show the selection as a pill +
                    open the picker popover on click. The picker reuses the
                    shared UserResultList primitive (same shape as the
                    header search), composed with rich rows. */}
                    {interestUserHandle ? (
                        <button
                            type="button"
                            onClick={() => onChange({ userHandle: null })}
                            className={chip(true)}
                            title="Clear the person filter"
                        >
                            @{interestUserHandle} ✕
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setPickerOpen((v) => !v)}
                            className={chip(false)}
                            aria-label="Filter to a single person you follow"
                            aria-expanded={pickerOpen}
                            title="Filter to a single person you follow"
                        >
                            + <span className="sm:hidden">Person</span><span className="hidden sm:inline">Pick a person</span>
                        </button>
                    )}
                </>
            )}
            {!signedIn && showAnonHint && (
                <span className="text-xs text-slate-500">
                    <Link to="/login" className="text-blue-600 hover:underline">
                        Sign in
                    </Link>{' '}
                    to see picks from people you follow.
                </span>
            )}
            {pickerOpen && signedIn && (
                <div className="relative w-full">
                    <UserInterestPicker
                        onPick={(handle) => {
                            onChange({ userHandle: handle });
                            setPickerOpen(false);
                        }}
                        onClose={() => setPickerOpen(false)}
                    />
                </div>
            )}
        </div>
    );
}
