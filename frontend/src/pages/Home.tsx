import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { CalendarEvent, TagGroup } from '../types';
import { fetchEvents, fetchSettings, fetchTagGroups, fetchMyFollowing, type ReachFilter, type FollowUser } from '../api';
import PeopleFilterPanel from '../components/PeopleFilterPanel';
import PeopleAvatarTrack, { type PersonMini } from '../components/PeopleAvatarTrack';
import { trackView } from '../utils/tracking';
import { filterEventsByTags } from '../utils/tagFilter';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type { CalendarViewMode } from '../components/Calendar';
import CalendarMapWorkspace from '../components/CalendarMapWorkspace';
import EventMap from '../components/EventMap';
import type { MapBounds } from '../components/EventMap';
import EventModal from '../components/EventModal';
import AdminEventDetailPanel from '../components/AdminEventDetailPanel';
import DateRangePicker from '../components/DateRangePicker';
import EventListPanel from '../components/EventListPanel';
import MyEventsMapPreview from '../components/MyEventsMapPreview';
import SummaryBar from '../components/SummaryBar';
import ViewSwitcher from '../components/ViewSwitcher';
import type { ExploreView } from '../components/ViewSwitcher';
import FilterSheet from '../components/FilterSheet';
import type { FilterSheetSection } from '../components/FilterSheet';
import AreaEditor from '../components/AreaEditor';
import AreaMapPreview from '../components/AreaMapPreview';
import TagFilterPills from '../components/TagFilterPills';
import MoreFiltersEditor from '../components/MoreFiltersEditor';
import SearchProfileFlow from '../components/SearchProfileFlow';
import { usePreferences } from '../context/PreferencesContext';
import { useActiveProfile } from '../hooks/useActiveProfile';
import { useInterestProfiles } from '../hooks/useInterestProfiles';
import { matchSearchProfile } from '../utils/searchProfiles';
import { eventMatchesReach, REACH_FILTER_ICON_SRC, REACH_FILTER_LABELS } from '../utils/reach';
import { useInvalidateAttendanceSummaries } from '../context/AttendanceSummariesContext';

import { AREA_PRESETS, DEFAULT_AREA_BBOX, DEFAULT_AREA_LABEL } from '../constants/area';
import type { PreferredAreaPayload, InterestProfile, InterestProfileUpdatePayload } from '../api';
import SuggestEventModal from '../components/SuggestEventModal';
import EventAnchoredDetailPanel from '../components/EventAnchoredDetailPanel';
import { useSeenEvents } from '../hooks/useSeenEvents';
import TrendingEventsBanner from '../components/TrendingEventsBanner';
import { DEFAULT_EXPLORER_PERIOD, getDateRangeForPreset } from '../utils/dateRangePresets';
import type { DateRangePresetKey } from '../utils/dateRangePresets';
import {
    bboxSearchArea,
    customAreaFromBounds,
    searchAreaContainsCoordinates,
    searchAreaFromProfile,
    toPreferredArea,
    toProfileGeometry,
    type SearchArea,
} from '../utils/searchArea';

// Worldwide bbox shortcut reused by the area sheet's "Anywhere" apply path.
const WORLDWIDE_AREA: PreferredAreaPayload =
    AREA_PRESETS.find((preset) => preset.label === 'Worldwide') ?? DEFAULT_AREA_BBOX;

type ViewMode = 'explorer' | 'calendar';
type InterestSource = 'follows' | 'friends';
type InterestKind = 'any' | 'going' | 'saved';
type InterestMatch = 'any' | 'all';
type ExplorerSort = 'date' | 'popularity';

// Drives the two flavors of this view: the public Explorer ("/") and the
// signed-in Tribe list ("/tribe/calendars"). Both render the same component;
// only these defaults differ.
export interface ExplorerViewConfig {
    variant: 'explorer' | 'tribe';
    /** Interest-source the view opens on when the URL doesn't specify one. */
    defaultInterestSource: InterestSource | null;
    defaultInterestKind: InterestKind;
    defaultSort: ExplorerSort;
    /** 'show-all' opens with no geo restriction (worldwide). */
    areaMode: 'preset' | 'show-all';
    /** 'all' opens with no end-date cap (all upcoming events). */
    dateMode: 'preset' | 'all';
    cardVariant: 'default' | 'tribe';
    /** When true, clearing the people filter falls back to 'follows' instead
     * of removing it entirely (Tribe always keeps at least Following). */
    peopleFilterMinimum: boolean;
    requireAuth: boolean;
}

const EXPLORER_CONFIG: ExplorerViewConfig = {
    variant: 'explorer',
    defaultInterestSource: null,
    defaultInterestKind: 'going',
    defaultSort: 'date',
    areaMode: 'preset',
    dateMode: 'preset',
    cardVariant: 'default',
    peopleFilterMinimum: false,
    requireAuth: false,
};

const TRIBE_CONFIG: ExplorerViewConfig = {
    variant: 'tribe',
    defaultInterestSource: 'follows',
    defaultInterestKind: 'going',
    defaultSort: 'popularity',
    areaMode: 'show-all',
    dateMode: 'all',
    cardVariant: 'tribe',
    peopleFilterMinimum: true,
    requireAuth: true,
};

interface FutureEventBatch {
    endDate: string;
    matchingCount: number;
}

interface InitialExplorerState {
    startDate: string;
    endDate: string;
    interestSource: InterestSource | null;
    interestKind: InterestKind;
    interestUserHandles: string[];
    interestMatch: InterestMatch;
    sortBy: ExplorerSort;
}

const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function defaultExplorerDateRange(period: DateRangePresetKey = DEFAULT_EXPLORER_PERIOD): { startDate: string; endDate: string } {
    return getDateRangeForPreset(period);
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

function parseInterestMatch(value: string | null): InterestMatch | null {
    return value === 'any' || value === 'all' ? value : null;
}

function parseExplorerSort(value: string | null): ExplorerSort | null {
    return value === 'date' || value === 'popularity' ? value : null;
}

function normalizeUserHandleParam(value: string | null): string | null {
    const trimmed = value?.trim().replace(/^@/, '') ?? '';
    return trimmed.length ? trimmed : null;
}

function readInitialExplorerState(searchParams: URLSearchParams, config: ExplorerViewConfig): InitialExplorerState {
    const defaults = defaultExplorerDateRange();
    const interestUserHandles = Array.from(new Set(
        searchParams.getAll('interest_user_handle')
            .map(normalizeUserHandleParam)
            .filter((h): h is string => h !== null),
    ));
    const interestSource = parseInterestSource(searchParams.get('interest_source')) ?? (interestUserHandles.length ? 'follows' : config.defaultInterestSource);
    return {
        startDate: parseDateParam(searchParams.get('start_date')) ?? defaults.startDate,
        endDate: parseDateParam(searchParams.get('end_date')) ?? (config.dateMode === 'all' ? '' : defaults.endDate),
        interestSource,
        interestKind: parseInterestKind(searchParams.get('interest_kind')) ?? config.defaultInterestKind,
        interestUserHandles,
        interestMatch: parseInterestMatch(searchParams.get('interest_match')) ?? 'any',
        sortBy: parseExplorerSort(searchParams.get('sort_by')) ?? config.defaultSort,
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
        interestUserHandles: string[];
        interestMatch: InterestMatch;
        sortBy: ExplorerSort;
    },
) {
    next.set('start_date', state.startDate);
    // Empty endDate = "no end cap" (Tribe's all-upcoming mode); omit the param.
    if (state.endDate) next.set('end_date', state.endDate);
    else next.delete('end_date');

    const tagIds = [...state.activeTagIds].sort((a, b) => a - b);
    if (tagIds.length > 0) next.set('tag_ids', tagIds.join(','));
    else if (state.shouldPersistEmptyTags) next.set('tag_ids', '');
    else next.delete('tag_ids');

    const interestActive = state.interestSource !== null || state.interestUserHandles.length > 0;
    if (interestActive) {
        next.set('interest_source', state.interestSource ?? 'follows');
        next.set('interest_kind', state.interestKind);
        if (state.interestMatch === 'all') next.set('interest_match', 'all');
        else next.delete('interest_match');
        next.delete('interest_user_handle');
        for (const h of state.interestUserHandles) next.append('interest_user_handle', h);
    } else {
        next.delete('interest_source');
        next.delete('interest_kind');
        next.delete('interest_match');
        next.delete('interest_user_handle');
    }

    if (state.sortBy === 'popularity') next.set('sort_by', state.sortBy);
    else next.delete('sort_by');
}

// Loose OR match used previously by the "For you" rail's Recommended lens
// lives on the /for-you page now.

export function ExplorerView({ config = EXPLORER_CONFIG }: { config?: ExplorerViewConfig }) {
    const { user, loading: authLoading } = useAuth();
    const { showPrices, showPopularity, showRatings, popularityThreshold, tagSortMode, unseenStateEnabled, trendingEnabled, trendingBannerEnabled, trendingTopN, trendingTopPercent, followingBadgeEnabled } = useFeatureFlags();
    const [showSuggestModal, setShowSuggestModal] = useState(false);
    const mapFollowingBadgeOverlay = true;
    const mapTrendingOverlay = true;
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const [initialExplorerState] = useState(() => readInitialExplorerState(searchParams, config));
    const [initialUrlHadDateRange] = useState(() => searchParams.has('start_date') || searchParams.has('end_date'));

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
    const [sinceDate, setSinceDate] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [selectedEventSource, setSelectedEventSource] = useState<string | null>(null);
    const [editingEventId, setEditingEventId] = useState<string | null>(null);
    const [sortBy, setSortBy] = useState<ExplorerSort>(initialExplorerState.sortBy);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    // The two tag groups that make up the user's default profile (alongside
    // area): dance styles and event reach ("Event reach").
    const danceGroup = useMemo(() => tagGroups.find((g) => g.slug === 'dance-style') ?? null, [tagGroups]);
    const reachGroup = useMemo(() => tagGroups.find((g) => g.slug === 'reach') ?? null, [tagGroups]);
    // "Event format" is a session-only tag group; everything else (excluding
    // the three primary dimensions) falls under "More filters".
    const formatGroup = useMemo(() => tagGroups.find((g) => g.slug === 'format') ?? null, [tagGroups]);
    const moreGroups = useMemo(
        () => tagGroups.filter((g) => g.slug !== 'dance-style' && g.slug !== 'reach' && g.slug !== 'format'),
        [tagGroups],
    );
    const [activeTagIds, setActiveTagIds] = useState<Set<number>>(() => new Set(parseTagIdsParam(searchParams.get('tag_ids'))));
    const initialReachFilter = searchParams.get('reach');
    const [reachFilter, setReachFilter] = useState<ReachFilter>(
        initialReachFilter === 'regional_plus' || initialReachFilter === 'international'
            ? initialReachFilter
            : 'any',
    );
    const userTouchedReachRef = useRef(searchParams.has('reach'));
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
    // ``Search this area`` should keep the current zoom/pan instead of
    // tightening to the newly available markers. The flag below suppresses
    // the map's marker-refit effect until the next explicit reframing action.
    const [preserveViewportAfterSearch, setPreserveViewportAfterSearch] = useState(false);
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
    const { prefs } = usePreferences();
    // Active interest profile is the source of truth for the user's default
    // area + dance styles + event reach. Explore reads defaults via ``prefs``
    // (kept in sync) and persists new defaults through ``saveDefaults``.
    const { activeProfile, saveDefaults } = useActiveProfile();
    // Full profile list + CRUD for the search-profile picker/editor. Signed-in
    // only; anonymous users keep a single localStorage default (no picker).
    const {
        profiles: searchProfiles,
        reload: reloadSearchProfiles,
        createProfile,
        updateProfile,
        deleteProfile,
    } = useInterestProfiles();

    useEffect(() => {
        if (userTouchedReachRef.current || !activeProfile) return;
        setReachFilter(activeProfile.reach_filter);
    }, [activeProfile]);
    // Session-only opt-out so the user can browse "worldwide" without
    // touching their saved prefs, OR a one-click switch back to the
    // hardcoded "Europe & nearby" preset. Reload resets it (matches design
    // doc).
    const [areaSessionOverride, setAreaSessionOverride] = useState<
        | { kind: 'show-all' }
        | { kind: 'preset'; area: SearchArea }
        | null
    >(config.areaMode === 'show-all' ? { kind: 'show-all' } : null);

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
    // above which calls flyToArea explicitly. On mobile, if a pending
    // flyToAreaBbox exists at the time the map mounts (e.g., user applied
    // an area in list view then opened Map mode), the pending bbox takes
    // precedence so the map does not display stale/default bounds.
    const initialAreaRef = useRef<PreferredAreaPayload>(prefs.area ?? DEFAULT_AREA_BBOX);
    const resolvedInitialArea = flyToAreaBbox ?? initialAreaRef.current;

    const effectiveArea: SearchArea | null = useMemo(() => {
        if (areaSessionOverride?.kind === 'show-all') return null;
        if (areaSessionOverride?.kind === 'preset') return areaSessionOverride.area;
        if (activeProfile) return searchAreaFromProfile(activeProfile);
        if (prefs.area) return bboxSearchArea(prefs.area, 'preference');
        return bboxSearchArea(DEFAULT_AREA_BBOX, 'preset');
    }, [activeProfile, areaSessionOverride, prefs.area]);

    // Dance + reach tag ids currently active — the two tag dimensions that,
    // together with the effective area, make up a "search profile".
    const danceTagIds = useMemo(
        () => (danceGroup ? danceGroup.tags.filter((t) => activeTagIds.has(t.id)).map((t) => t.id) : []),
        [danceGroup, activeTagIds],
    );
    const reachTagIds = useMemo(
        () => {
            if (!reachGroup || reachFilter === 'any') return [];
            const slugs = reachFilter === 'international'
                ? new Set(['international'])
                : new Set(['regional', 'international']);
            return reachGroup.tags.filter((tag) => slugs.has(tag.slug)).map((tag) => tag.id);
        },
        [reachGroup, reachFilter],
    );
    // The saved profile whose Area + Dance + Reach exactly match the live
    // search, or null (the user-facing "Current search"). Derived — no
    // separate selection state.
    const matchedSearchProfile = useMemo(
        () => matchSearchProfile({ area: effectiveArea, danceIds: danceTagIds, reachFilter, reachIds: reachTagIds }, searchProfiles),
        [effectiveArea, danceTagIds, reachFilter, reachTagIds, searchProfiles],
    );
    const selectedSearchProfileId: number | 'custom' = matchedSearchProfile ? matchedSearchProfile.id : 'custom';
    // Search-profile flow overlay: null = closed, else the entry step.
    const [searchProfileStep, setSearchProfileStep] = useState<'picker' | 'save' | null>(null);

    // Apply a saved profile's Area + Dance + Reach to the live search (session
    // only). Dates, People and More filters are intentionally left untouched.
    const handleApplySearchProfile = useCallback((profile: InterestProfile) => {
        setPreserveViewportAfterSearch(true);
        setUserMapBounds(null);
        userTouchedTagsRef.current = true;
        setActiveTagIds((prev) => {
            const next = new Set(prev);
            danceGroup?.tags.forEach((t) => next.delete(t.id));
            reachGroup?.tags.forEach((t) => next.delete(t.id));
            profile.dance_tag_ids.forEach((id) => next.add(id));
            return next;
        });
        userTouchedReachRef.current = true;
        setReachFilter(profile.reach_filter);
        const area = searchAreaFromProfile(profile);
        if (profile.is_active) {
            // The default profile — clear the session override so it reads as
            // the clean saved default rather than a one-off preset.
            setAreaSessionOverride(null);
            flyToArea(toPreferredArea(area));
        } else {
            setAreaSessionOverride({ kind: 'preset', area });
            flyToArea(toPreferredArea(area));
        }
    }, [danceGroup, reachGroup, flyToArea]);

    // Update the selected profile's Area + Dance + Reach with the live values.
    // For the active profile, synchronizes preferences and refits the map.
    // For non-active profiles, updates only the profile fields without activating.
    const handleUpdateProfile = useCallback(
        async (profile: InterestProfile) => {
            const payload: InterestProfileUpdatePayload = {
                dance_tag_ids: danceTagIds,
                reach_filter: reachFilter,
            };
            if (effectiveArea) Object.assign(payload, toProfileGeometry(effectiveArea));

            if (profile.is_active) {
                // Active profile: use saveDefaults to maintain preference sync.
                const input: { area?: SearchArea; danceTagIds?: number[]; reachFilter?: ReachFilter } = {
                    danceTagIds: danceTagIds,
                    reachFilter,
                };
                if (effectiveArea) input.area = effectiveArea;
                suppressNextPrefsFitRef.current = true;
                setAreaSessionOverride(null);
                await saveDefaults(input);
                await reloadSearchProfiles();
            } else {
                // Non-active profile: update directly without activation.
                await updateProfile(profile.id, payload);
            }
        },
        [danceTagIds, reachFilter, effectiveArea, saveDefaults, reloadSearchProfiles, updateProfile],
    );

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
    const [defaultExplorerPeriod, setDefaultExplorerPeriod] = useState<DateRangePresetKey>(DEFAULT_EXPLORER_PERIOD);
    const userTouchedDateRangeRef = useRef(initialUrlHadDateRange);

    // Interest filter (Phase: interest-filter-following). Restricts the explorer
    // feed to events at least one user in the chosen graph has marked
    // going / saved.
    //   • `interestSource` = which graph: `follows` (anyone the viewer
    //     follows, one-way OK) or `friends` (mutual followers only).
    //     `null` = filter off.
    //   • `interestKind` = which signal: `any` (going OR saved), `going`,
    //     `saved`. Defaults to `any` so the chip works as a one-click
    //     "what are people I follow up to" toggle.
    //   • `interestUserHandles` = optional narrow to one or more specific
    //     users (any user, not necessarily followed). Non-empty implies
    //     the filter is on.
    // Backend enforces per-row audience visibility; non-mutual followers
    // never see `friends`-audience rows.
    const [interestSource, setInterestSource] = useState<InterestSource | null>(initialExplorerState.interestSource);
    const [interestKind, setInterestKind] = useState<InterestKind>(initialExplorerState.interestKind);
    const [interestUserHandles, setInterestUserHandles] = useState<string[]>(initialExplorerState.interestUserHandles);
    const [interestMatch, setInterestMatch] = useState<InterestMatch>(initialExplorerState.interestMatch);
    // Resolve explicitly-selected people handles to avatar minis so the filter
    // bar's people chip and the filter sheet's people row can show faces
    // instead of a bare count. Falls back to initials when the viewer isn't
    // following the selected user (or isn't signed in).
    const [followingIndex, setFollowingIndex] = useState<Record<string, FollowUser>>({});
    useEffect(() => {
        if (!user || interestUserHandles.length === 0) return;
        let cancelled = false;
        fetchMyFollowing({ limit: 200 })
            .then((res) => {
                if (cancelled) return;
                const idx: Record<string, FollowUser> = {};
                for (const u of res.items) idx[u.handle.replace(/^@/, '')] = u;
                setFollowingIndex(idx);
            })
            .catch(() => { /* keep initials fallback */ });
        return () => { cancelled = true; };
    }, [user, interestUserHandles.length]);
    const interestUserPeople = useMemo<PersonMini[]>(
        () => interestUserHandles.map((h) => {
            const f = followingIndex[h.replace(/^@/, '')];
            return { handle: h, display_name: f?.display_name ?? null, avatar_url: f?.avatar_url ?? null };
        }),
        [interestUserHandles, followingIndex],
    );
    const [selectedExplorerMapEventId, setSelectedExplorerMapEventId] = useState<string | null>(null);

    // Calendar mode map bounds (for off-map styling in the calendar grid)
    const [calMapBounds, setCalMapBounds] = useState<MapBounds | null>(null);

    const navigate = useNavigate();

    // Auth-gated variants (Tribe) bounce signed-out visitors to sign-in.
    useEffect(() => {
        if (config.requireAuth && !authLoading && !user) {
            navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
        }
    }, [config.requireAuth, authLoading, user, navigate, location.pathname]);

    // Cross-component hover highlight
    const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
    const handleEventHover = useCallback((eventId: string | null) => {
        setHoveredEventId(eventId);
        // Hover in rails / map / calendar does NOT mark an event seen —
        // otherwise the "New" lens loses its own contents the instant it
        // renders and the viewer hovers a card. The explorer list panel
        // uses `handleExplorerListEventHover` below, which does.
    }, []);
    // Rail hover is kept in a SEPARATE state so it doesn't drive the
    // explorer list's auto-scroll effect (or any other cross-surface
    // side effect wired to `hoveredEventId`). Rails still get a proper
    // card-level highlight via this dedicated state — they just don't
    // yank the list to the hovered event.
    const [railHoveredEventId, setRailHoveredEventId] = useState<string | null>(null);
    const handleRailEventHover = useCallback((eventId: string | null) => {
        setRailHoveredEventId(eventId);
    }, []);
    // Hover-to-seen is scoped to the explorer LIST only (per product
    // decision): brushing past a card in the visible list clears its
    // unseen dot, matching the behavior of Twitter/Slack unread markers.
    // Trails (ForYou / Your next events) and the map intentionally skip
    // this so their "New" affordances stay stable while the viewer is
    // still deciding whether to open a card.

    // Map fullscreen toggle (mobile only — desktop layout already gives the
    // map a tall column). The map container picks up ``fixed inset-0`` when
    // active so users can scan markers without the URL bar / filters eating
    // screen height. Initialised from ``?view=map`` so a shared / reloaded
    // link opens straight into the fullscreen map.
    const [mapFullscreen, setMapFullscreen] = useState(() => searchParams.get('view') === 'map');

    const activeView: ExploreView = viewMode === 'calendar'
        ? 'calendar'
        : mapFullscreen
            ? 'map'
            : 'list';
    const handleSelectView = useCallback((nextView: ExploreView) => {
        const nextParams = new URLSearchParams(searchParams);
        if (nextView === 'calendar') {
            nextParams.delete('view');
            setMapFullscreen(false);
            navigate({ pathname: '/calendar', search: nextParams.toString() });
            return;
        }
        const openMap = nextView === 'map';
        if (openMap) nextParams.set('view', 'map');
        else nextParams.delete('view');
        setMapFullscreen(openMap);
        navigate({ pathname: '/', search: nextParams.toString() });
    }, [navigate, searchParams]);

    // Opening the fullscreen map resizes the shared map container; re-fit to
    // markers so it opens centered instead of keeping the miniature's viewport.
    // On collapse back to the miniature we also drop any viewport the user
    // panned to in fullscreen so the miniature recenters on the results.
    useEffect(() => {
        if (!mapFullscreen) setUserMapBounds(null);
        bumpAutoFit();
    }, [mapFullscreen, bumpAutoFit]);

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
            interestUserHandles,
            interestMatch,
            sortBy,
        });
        if (reachFilter !== 'any') next.set('reach', reachFilter);
        else if (userTouchedReachRef.current || searchParams.has('reach')) next.set('reach', 'any');
        else next.delete('reach');
        // Reflect the fullscreen map view in the URL so it is shareable and
        // survives reload; the back button returns to the list.
        if (mapFullscreen) next.set('view', 'map');
        else next.delete('view');
        if (next.toString() !== searchParams.toString()) {
            setSearchParams(next, { replace: true });
        }
    }, [activeTagIds, endDate, interestKind, interestMatch, interestSource, interestUserHandles, mapFullscreen, reachFilter, searchParams, setSearchParams, sortBy, startDate, viewMode]);

    // Events query source: Explorer pulls the date/interest-filtered set once
    // and applies the active area + tag filters client-side. The live map
    // viewport only classifies events as on-map/off-map; it no longer hides
    // matching events from the Explorer list or subsequent map refits.
    const initialLoadDone = useRef(false);
    const [visibleRange, setVisibleRange] = useState<{ start: Date; end: Date } | null>(null);
    useEffect(() => {
        setLoading(true);
        setError(null);
        let params: { startDate?: string; endDate?: string; area?: PreferredAreaPayload | null; interestSource?: 'follows' | 'friends'; interestKind?: 'any' | 'going' | 'saved'; interestUserHandles?: string[]; interestMatch?: 'any' | 'all' } | undefined;
        const interestActive = interestSource !== null || interestUserHandles.length > 0;
        if (viewMode === 'explorer') {
            // No ``area`` here on purpose — we pull the full date/interest set
            // and apply the active area locally. That keeps panning instant,
            // while semantic filters (tags/following) can still refit to all
            // matching events in the active/default area.
            params = {
                startDate,
                endDate: endDate || undefined,
                interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
                interestKind: interestActive ? interestKind : undefined,
                interestUserHandles: interestUserHandles.length ? interestUserHandles : undefined,
                interestMatch: interestActive ? interestMatch : undefined,
            };
        } else if (visibleRange) {
            params = {
                startDate: formatDate(visibleRange.start),
                endDate: formatDate(visibleRange.end),
                interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
                interestKind: interestActive ? interestKind : undefined,
                interestUserHandles: interestUserHandles.length ? interestUserHandles : undefined,
                interestMatch: interestActive ? interestMatch : undefined,
            };
        } else {
            // Calendar mode initial load: use same default as explorer
            params = {
                startDate,
                endDate: endDate || undefined,
                interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
                interestKind: interestActive ? interestKind : undefined,
                interestUserHandles: interestUserHandles.length ? interestUserHandles : undefined,
                interestMatch: interestActive ? interestMatch : undefined,
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
                const nextDefaultPeriod = settings.default_explorer_period ?? DEFAULT_EXPLORER_PERIOD;
                setDefaultExplorerPeriod(nextDefaultPeriod);
                if (viewMode === 'explorer' && !initialUrlHadDateRange && !userTouchedDateRangeRef.current) {
                    const defaults = defaultExplorerDateRange(nextDefaultPeriod);
                    setStartDate(defaults.startDate);
                    setEndDate(config.dateMode === 'all' ? '' : defaults.endDate);
                }
                const loadedReachGroup = groups.find((group) => group.slug === 'reach');
                const selectedReachTags = loadedReachGroup?.tags.filter((tag) => activeTagIds.has(tag.id)) ?? [];
                if (selectedReachTags.length > 0) {
                    if (!userTouchedReachRef.current) {
                        const slugs = new Set(selectedReachTags.map((tag) => tag.slug));
                        setReachFilter(
                            slugs.has('regional')
                                ? 'regional_plus'
                                : slugs.has('international')
                                    ? 'international'
                                    : 'any',
                        );
                    }
                    setActiveTagIds((current) => {
                        const next = new Set(current);
                        selectedReachTags.forEach((tag) => next.delete(tag.id));
                        return next;
                    });
                }
                setTagGroups(groups);
            })
            .catch((e) => setError(e.message))
            .finally(() => {
                setLoading(false);
                initialLoadDone.current = true;
            });
    }, [viewMode, startDate, endDate, visibleRange, interestSource, interestKind, interestUserHandles, interestMatch, initialUrlHadDateRange, config.dateMode]);

    const handleDateRangeChange = useCallback((start: string, end: string) => {
        userTouchedDateRangeRef.current = true;
        setPreserveViewportAfterSearch(false);
        setStartDate(start);
        setEndDate(end);
        bumpAutoFit();
    }, [bumpAutoFit]);

    const handleToggleTag = useCallback((tagId: number) => {
        userTouchedTagsRef.current = true;
        setPreserveViewportAfterSearch(false);
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

    // Clear only the tags belonging to a single group (used by the per-group
    // filter sub-editors so "Clear" scopes to that dimension).
    const handleClearGroupTags = useCallback((group: TagGroup) => {
        userTouchedTagsRef.current = true;
        setPreserveViewportAfterSearch(false);
        bumpAutoFit();
        setActiveTagIds((prev) => {
            const next = new Set(prev);
            for (const t of group.tags) next.delete(t.id);
            return next;
        });
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
        userTouchedDateRangeRef.current = true;
        setPreserveViewportAfterSearch(false);
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
        const defaults = defaultExplorerDateRange(defaultExplorerPeriod);
        userTouchedDateRangeRef.current = false;
        userTouchedTagsRef.current = true;
        setPreserveViewportAfterSearch(false);
        setActiveTagIds(new Set());
        userTouchedReachRef.current = true;
        setReachFilter('any');
        setInterestSource(config.peopleFilterMinimum ? 'follows' : null);
        setInterestKind(config.peopleFilterMinimum ? config.defaultInterestKind : 'any');
        setInterestUserHandles([]);
        setStartDate(defaults.startDate);
        setEndDate(config.dateMode === 'all' ? '' : defaults.endDate);
        setAreaSessionOverride(config.areaMode === 'show-all' ? { kind: 'show-all' } : null);
        bumpAutoFit();
    }, [bumpAutoFit, config.areaMode, config.dateMode, config.defaultInterestKind, config.peopleFilterMinimum, defaultExplorerPeriod]);

    const handleClearCalendarFilters = useCallback(() => {
        userTouchedTagsRef.current = true;
        setPreserveViewportAfterSearch(false);
        setActiveTagIds(new Set());
        setInterestSource(config.peopleFilterMinimum ? 'follows' : null);
        setInterestKind(config.peopleFilterMinimum ? config.defaultInterestKind : 'any');
        setInterestUserHandles([]);
        bumpAutoFit();
    }, [bumpAutoFit, config.defaultInterestKind, config.peopleFilterMinimum]);

    // Clear area filter and show events from all areas worldwide.
    const handleClearAreaOverride = useCallback(() => {
        setPreserveViewportAfterSearch(false);
        setAreaSessionOverride({ kind: 'show-all' });
        bumpAutoFit();
    }, [bumpAutoFit]);

    // Reset filters to the user's saved defaults: the active profile's area +
    // dance + event-scale tags (mirrored into ``prefs``) and the default
    // explorer period. Session-only filters (event format, more tags,
    // people) are dropped.
    const handleResetFilters = useCallback(() => {
        const defaults = defaultExplorerDateRange(defaultExplorerPeriod);
        userTouchedDateRangeRef.current = false;
        userTouchedTagsRef.current = true;
        setPreserveViewportAfterSearch(false);
        setActiveTagIds(new Set(prefs.tagIds));
        userTouchedReachRef.current = true;
        setReachFilter(activeProfile?.reach_filter ?? 'any');
        setInterestSource(config.peopleFilterMinimum ? 'follows' : null);
        setInterestKind(config.defaultInterestKind);
        setInterestUserHandles([]);
        setStartDate(defaults.startDate);
        setEndDate(config.dateMode === 'all' ? '' : defaults.endDate);
        setAreaSessionOverride(config.areaMode === 'show-all' ? { kind: 'show-all' } : null);
        bumpAutoFit();
    }, [activeProfile?.reach_filter, bumpAutoFit, config.areaMode, config.dateMode, config.defaultInterestKind, config.peopleFilterMinimum, defaultExplorerPeriod, prefs.tagIds]);

    // People-scoped Clear (sub-editor header action): remove the People filter
    // entirely — no scope, any status, no specific people. Never re-selects a
    // default scope, and never unfollows anyone.
    const handleClearPeople = useCallback(() => {
        setInterestSource(config.peopleFilterMinimum ? 'follows' : null);
        setInterestKind(config.peopleFilterMinimum ? config.defaultInterestKind : 'any');
        setInterestUserHandles([]);
        setInterestMatch('any');
        bumpAutoFit();
    }, [bumpAutoFit, config.defaultInterestKind, config.peopleFilterMinimum]);

    // Dedicated area picker (reached from the area chip in the list, the
    // fullscreen map header, and desktop) is now the FilterSheet's "Area"
    // section. Apply = session override only; "Set as my default area"
    // persists to the profile via the active profile.
    const handleApplyAreaFromSheet = useCallback((area: SearchArea | null) => {
        setPreserveViewportAfterSearch(true);
        setUserMapBounds(null);
        if (!area) {
            setAreaSessionOverride({ kind: 'show-all' });
            flyToArea({ ...WORLDWIDE_AREA });
        } else {
            setAreaSessionOverride({ kind: 'preset', area });
            flyToArea(toPreferredArea(area));
        }
    }, [flyToArea]);

    const handleExploreAreaFromSheet = useCallback((area: SearchArea) => {
        setPreserveViewportAfterSearch(true);
        setUserMapBounds(null);
        setAreaSessionOverride({ kind: 'preset', area });
        flyToArea(toPreferredArea(area));
        setFilterSheetSection(null);
        setFilterSheetOpen(false);
        handleSelectView('map');
    }, [flyToArea, handleSelectView]);

    // Mobile-only FilterSheet open state. The sheet wraps the same controls
    // rendered inline on desktop so the landing page isn't crushed by a
    // tall filter stack on phones. State stays lifted in this component so
    // closing/opening the sheet doesn't reset anything.
    const [filterSheetOpen, setFilterSheetOpen] = useState(false);
    // Deep-link target: when a specific SummaryBar chip (Area / Dance / Event
    // scale / People / +N) opens the sheet, jump straight into that section.
    const [filterSheetSection, setFilterSheetSection] = useState<string | null>(null);
    const openFilterSheet = useCallback((section: string | null = null) => {
        setFilterSheetSection(section);
        setFilterSheetOpen(true);
    }, []);
    const defaultDateRange = useMemo(() => defaultExplorerDateRange(defaultExplorerPeriod), [defaultExplorerPeriod]);
    const dateRangeDiffers =
        startDate !== defaultDateRange.startDate || endDate !== defaultDateRange.endDate;
    const activeFilterCount =
        activeTagIds.size
        + (interestSource ? 1 : 0)
        + (interestUserHandles.length ? 1 : 0)
        + (areaSessionOverride ? 1 : 0)
        + (dateRangeDiffers ? 1 : 0);
    const calendarActiveFilterCount = activeTagIds.size
        + (interestSource ? 1 : 0)
        + (interestUserHandles.length ? 1 : 0);

    // Map fullscreen toggle (mobile only — desktop layout already gives the
    // map a tall column). Declared earlier (near the URL sync effect).
    const [areaPresetMenuOpen, setAreaPresetMenuOpen] = useState(false);

    // Commit the current map viewport as the effective area filter. Paired
    // with the "Search this area" pill that appears after the user pans
    // the map; the pill disappears once committed because ``userMapBounds``
    // is cleared below. We deliberately do NOT auto-fit the map to the
    // returned events here — the user just framed the viewport they care
    // about, and re-fitting (especially to a single event) would zoom in and
    // lose their sense of orientation. The current zoom/pan is kept as-is.
    const handleSearchThisArea = useCallback(() => {
        if (!userMapBounds) return;
        const area = customAreaFromBounds({
            min_lat: userMapBounds.south,
            max_lat: userMapBounds.north,
            min_lng: userMapBounds.west,
            max_lng: userMapBounds.east,
        });
        setPreserveViewportAfterSearch(true);
        setAreaSessionOverride({ kind: 'preset', area });
        setUserMapBounds(null);
    }, [userMapBounds]);

    // Footer preset actions: apply the new area filter but keep the user's
    // current zoom/pan (no marker-tightening refit).
    const applyPresetAreaInPlace = useCallback((preset: (typeof AREA_PRESETS)[number]) => {
        setPreserveViewportAfterSearch(true);
        setAreaSessionOverride({ kind: 'preset', area: bboxSearchArea(preset, 'preset') });
        setUserMapBounds(null);
        flyToArea({ ...preset });
    }, [flyToArea]);

    const applyDefaultAreaInPlace = useCallback(() => {
        const target = prefs.area ?? DEFAULT_AREA_BBOX;
        setPreserveViewportAfterSearch(true);
        setAreaSessionOverride(null);
        setUserMapBounds(null);
        flyToArea(target);
    }, [flyToArea, prefs.area]);

    const applyWorldwideInPlace = useCallback(() => {
        const worldwide = AREA_PRESETS.find((preset) => preset.label === 'Worldwide') ?? {
            label: 'Worldwide',
            min_lat: -55,
            min_lng: -170,
            max_lat: 75,
            max_lng: 170,
        };
        setPreserveViewportAfterSearch(true);
        setAreaSessionOverride({ kind: 'show-all' });
        setUserMapBounds(null);
        flyToArea({ ...worldwide });
    }, [flyToArea]);

    const areaScopedEvents = useMemo(() => {
        if (viewMode !== 'explorer' || !effectiveArea) return events;
        return events.filter((event) =>
            searchAreaContainsCoordinates(effectiveArea, event.latitude, event.longitude),
        );
    }, [events, effectiveArea, viewMode]);

    const filteredEvents = useMemo(
        () => filterEventsByTags(events, activeTagIds, tagGroups).filter((event) => eventMatchesReach(event, reachFilter)),
        [events, activeTagIds, reachFilter, tagGroups],
    );

    const explorerMatchingEvents = useMemo(
        () => {
            const tagFiltered = filterEventsByTags(areaScopedEvents, activeTagIds, tagGroups)
                .filter((event) => eventMatchesReach(event, reachFilter));
            // Hide events whose end time is already in the past — the
            // backend's ``startDate`` filter can still return an event
            // that started earlier today but wrapped past midnight into
            // the previous night (e.g. a Friday 22:00 → 01:00 social).
            // Ongoing events (start<=now<end) remain visible.
            // eslint-disable-next-line react-hooks/purity -- render-time clock snapshot for past-event filter
            const now = Date.now();
            return tagFiltered.filter((e) => !e.end || new Date(e.end).getTime() >= now);
        },
        [areaScopedEvents, activeTagIds, reachFilter, tagGroups],
    );

    // Keep the mobile map miniature always framed on the current results.
    useEffect(() => {
        if (isDesktop || mapFullscreen) return; // miniature only
        bumpAutoFit();
    }, [isDesktop, mapFullscreen, explorerMatchingEvents, bumpAutoFit]);

    useEffect(() => {
        if (viewMode !== 'explorer') {
            return;
        }
        const currentEnd = new Date(endDate);
        if (Number.isNaN(currentEnd.getTime())) {
            setNextAvailableEventBatch(null);
            return;
        }
        const interestActive = interestSource !== null || !!interestUserHandles.length;
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
                    interestUserHandles: interestUserHandles.length ? interestUserHandles : undefined,
                    interestMatch: interestActive ? interestMatch : undefined,
                });
                if (cancelled) return;
                const areaFiltered = effectiveArea
                    ? evts.filter((event) =>
                        searchAreaContainsCoordinates(effectiveArea, event.latitude, event.longitude),
                    )
                    : evts;
                const matching = filterEventsByTags(areaFiltered, activeTagIds, tagGroups)
                    .filter((event) => eventMatchesReach(event, reachFilter));
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
    }, [viewMode, endDate, interestSource, interestKind, interestUserHandles, interestMatch, effectiveArea, matchedSearchProfile, activeTagIds, reachFilter, tagGroups]);

    const selectedExplorerMapEvent = useMemo(
        () => explorerMatchingEvents.find((event) => event.event_id === selectedExplorerMapEventId) ?? null,
        [explorerMatchingEvents, selectedExplorerMapEventId],
    );

    // Mobile explorer map preview: a persistent bottom sheet (mirroring My
    // Events) previews an event and pages through the list. It defaults to
    // the first matching event so the sheet is never empty.
    const explorerPreviewEvent = (mapFullscreen && !isDesktop)
        ? (selectedExplorerMapEvent ?? explorerMatchingEvents[0] ?? null)
        : null;
    const explorerPreviewIndex = explorerPreviewEvent
        ? explorerMatchingEvents.findIndex((event) => event.event_id === explorerPreviewEvent.event_id)
        : -1;
    const stepExplorerMapPreview = useCallback((delta: number) => {
        setSelectedExplorerMapEventId((currentId) => {
            const anchorId = currentId ?? explorerMatchingEvents[0]?.event_id ?? null;
            const idx = explorerMatchingEvents.findIndex((event) => event.event_id === anchorId);
            if (idx < 0) return currentId;
            const nextIdx = Math.min(explorerMatchingEvents.length - 1, Math.max(0, idx + delta));
            const target = explorerMatchingEvents[nextIdx];
            if (!target) return currentId;
            setHoveredEventId(target.event_id);
            return target.event_id;
        });
    }, [explorerMatchingEvents]);

    const showTrendingBanner = viewMode === 'explorer'
        && trendingEnabled
        && trendingBannerEnabled
        && showPopularity
        && !mapFullscreen;

    // "For you" rail: each lens is a dedicated server-paginated fetch,
    // scoped to the viewer's SAVED preferred area (or DEFAULT_AREA_BBOX
    // when none is saved) and to events starting from today forward —
    // independent of the explorer's current pan/zoom or date-range
    // filters. "+more" triggers the next real server page for that lens.
    // Moved to the dedicated /for-you route — Home no longer renders the
    // For you or Your next events rails.
    const { newEventIds, markSeen } = useSeenEvents(eventIds);
    // Explorer-list hover marks an event seen — see the note near
    // `handleEventHover` above for why this is scoped to the list only.
    const handleExplorerListEventHover = useCallback((eventId: string | null) => {
        setHoveredEventId(eventId);
        if (eventId) markSeen(eventId);
    }, [markSeen]);

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

    // Explorer list panel click — opens the centered event modal (same as
    // My Calendar) instead of navigating to the full event page.
    const handleExplorerListEventClick = useCallback((evt: CalendarEvent) => {
        markSeen(evt.event_id);
        trackView(evt.event_id, 'explorer-list');
        setSelectedEventRect(null);
        setSelectedEventSource('explorer-list');
        setSelectedEvent(evt);
    }, [markSeen]);

    // Explorer map marker/popup click — opens the event modal.
    const handleExplorerMapEventClick = useCallback((evt: CalendarEvent) => {
        markSeen(evt.event_id);
        trackView(evt.event_id, 'explorer-map');
        setSelectedEventRect(null);
        setSelectedEventSource('explorer-map');
        setSelectedEvent(evt);
    }, [markSeen]);

    const handleExplorerMapMarkerSelect = useCallback((evt: CalendarEvent) => {
        setSelectedExplorerMapEventId(evt.event_id);
        setHoveredEventId(evt.event_id);
    }, []);

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
        const interestActive = interestSource !== null || !!interestUserHandles.length;
        const params = {
            ...(viewMode === 'explorer'
                ? { startDate, endDate }
                : visibleRange
                    ? { startDate: formatDate(visibleRange.start), endDate: formatDate(visibleRange.end) }
                    : { startDate, endDate }),
            interestSource: interestActive ? (interestSource ?? 'follows') : undefined,
            interestKind: interestActive ? interestKind : undefined,
            interestUserHandles: interestUserHandles.length ? interestUserHandles : undefined,
            interestMatch: interestActive ? interestMatch : undefined,
        };
        fetchEvents(params).then(setEvents).catch(() => { });
    }, [viewMode, startDate, endDate, visibleRange, interestKind, interestSource, interestUserHandles]);

    const handleBoundsChange = useCallback((bounds: MapBounds, userDriven: boolean) => {
        setMapBounds(bounds);
        if (userDriven) setUserMapBounds(bounds);
    }, []);

    const handleCalBoundsChange = useCallback((bounds: MapBounds) => {
        setCalMapBounds(bounds);
    }, []);

    // Set of event IDs not visible on the calendar-mode map
    const offMapEventIds = useMemo(() => {
        if (!calMapBounds) return new Set<string>();
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
    }, [calendarVisibleEvents, calMapBounds]);

    // Count of explorer-scope events currently outside the map viewport.
    // Shown in the map footer as an at-a-glance "you have N events not
    // visible on the map right now" hint. Events without coordinates are
    // treated as off-map (they can't be shown anywhere on the map).
    const explorerOffMapCount = useMemo(() => {
        if (!mapBounds) return 0;
        return explorerMatchingEvents.reduce((count, e) => {
            if (e.latitude == null || e.longitude == null) return count + 1;
            const onMap = e.latitude >= mapBounds.south
                && e.latitude <= mapBounds.north
                && e.longitude >= mapBounds.west
                && e.longitude <= mapBounds.east;
            return onMap ? count : count + 1;
        }, 0);
    }, [explorerMatchingEvents, mapBounds]);

    // Shared filter controls JSX, rendered inside the FilterSheet (bottom
    // sheet on mobile, centered modal on desktop — see `variant` on
    // <FilterSheet> below).
    const renderInterestFilters = () => (
        <PeopleFilterPanel
            signedIn={!!user}
            followingCount={user?.following_count}
            friendCount={user?.friend_count}
            interestSource={interestSource}
            interestKind={interestKind}
            interestUserHandles={interestUserHandles}
            interestMatch={interestMatch}
            onExploreAll={() => setFilterSheetOpen(false)}
            onChange={(next) => {
                bumpAutoFit();
                if (Object.prototype.hasOwnProperty.call(next, 'source')) {
                    setInterestSource(next.source ?? (config.peopleFilterMinimum ? 'follows' : null));
                    if (next.source === null) setInterestUserHandles([]);
                }
                if (Object.prototype.hasOwnProperty.call(next, 'kind')) {
                    setInterestKind(next.kind!);
                }
                if (Object.prototype.hasOwnProperty.call(next, 'match')) {
                    setInterestMatch(next.match!);
                }
                if (Object.prototype.hasOwnProperty.call(next, 'userHandles')) {
                    const nextHandles = next.userHandles ?? [];
                    setInterestUserHandles(nextHandles);
                    if (nextHandles.length > 0 && interestSource === null) {
                        setInterestSource('follows');
                    }
                }
            }}
        />
    );

    // Per-group pill editor reused by the Dance / Event reach / Event format /
    // More filters sub-editors. Scopes "Clear" to the group's own tags.
    const renderGroupPills = (group: TagGroup) => (
        <TagFilterPills
            tagGroups={[group]}
            activeTagIds={activeTagIds}
            onToggle={handleToggleTag}
            onClear={() => handleClearGroupTags(group)}
            countOverrides={tagCountMap}
            sortMode={tagSortMode}
        />
    );

    const renderReachFilter = () => (
        <div>
            <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-ink">
                <span>Event reach</span>
                <span title="Any includes events without a reach classification" aria-label="Any includes unclassified events">ⓘ</span>
            </div>
            <div role="group" aria-label="Event reach" className="grid grid-cols-3 border border-line">
                {(['any', 'regional_plus', 'international'] as const).map((choice) => (
                    <button
                        key={choice}
                        type="button"
                        aria-pressed={reachFilter === choice}
                        onClick={() => {
                            userTouchedReachRef.current = true;
                            setReachFilter(choice);
                            setPreserveViewportAfterSearch(false);
                            bumpAutoFit();
                        }}
                        className={reachFilter === choice
                            ? 'flex min-h-14 flex-col items-center justify-center gap-1 bg-blue-50 px-2 text-xs font-semibold text-action'
                            : 'flex min-h-14 flex-col items-center justify-center gap-1 px-2 text-xs font-semibold text-ink'}
                    >
                        <img src={REACH_FILTER_ICON_SRC[choice]} alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
                        {REACH_FILTER_LABELS[choice]}
                    </button>
                ))}
            </div>
        </div>
    );

    // Short summaries shown on each filter-sheet section row.
    const groupSummary = (group: TagGroup | null, placeholder: string): string => {
        if (!group) return placeholder;
        const sel = group.tags.filter((t) => activeTagIds.has(t.id));
        if (sel.length === 0) return placeholder;
        if (sel.length <= 2) return sel.map((t) => t.label).join(', ');
        return `${sel[0].label} +${sel.length - 1}`;
    };
    const groupSelCount = (group: TagGroup | null): number =>
        group ? group.tags.filter((t) => activeTagIds.has(t.id)).length : 0;
    const fmtDateShort = (iso: string): string => {
        const [y, m, d] = iso.split('-').map(Number);
        if (!y || !m || !d) return iso;
        return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    };
    // Effective area: show the resolved label (e.g. "Europe & nearby") even when
    // it's the silent default — only genuine worldwide reads as "Any".
    const areaSummary = areaChipState.kind === 'map-view'
        ? 'Current map view'
        : areaChipState.kind === 'show-all'
            ? 'Any'
            : areaChipState.label;
    // People chip wording: WHO · STATUS. "Both" = Going + Interested.
    const peopleSummary = (() => {
        const status = interestKind === 'going'
            ? 'Going'
            : interestKind === 'saved'
                ? 'Interested'
                : 'Both';
        const n = interestUserHandles.length;
        if (n > 0) return `${n} ${n === 1 ? 'person' : 'people'} · ${status}`;
        if (interestSource === 'friends') return `Friends · ${status}`;
        if (interestSource === 'follows') return `Following · ${status}`;
        return 'Any';
    })();

    // Sectioned explorer filters. Grouped per the approved UX: Dates → Search
    // profile (selector + Area + Dance + Event reach + optional Save) → Other
    // filters (People + Event format + More). Event format + More filters carry
    // the "+N" secondary badge.
    const signedIn = !!user;

    // Icon mapping for "more" filter groups based on their slugs
    const moreGroupIcons: Record<string, React.ReactNode> = {
        venue: <img src="/venue.png" alt="" className="h-4 w-4" />,
        scale: <img src="/size.png" alt="" className="h-4 w-4" />,
        level: <img src="/speedometer.png" alt="" className="h-4 w-4" />,
        misc: <img src="/more.png" alt="" className="h-4 w-4" />,
    };

    const explorerFilterSections: FilterSheetSection[] = [
        // Dates are driven by calendar navigation in calendar view, so the
        // Dates section is only offered in the explorer.
        ...(viewMode === 'calendar' ? [] : [{
            id: 'dates',
            label: 'Dates',
            icon: <img src="/calendar.png" alt="" className="h-4 w-4" />,
            group: 'Dates',
            summary: endDate ? `${fmtDateShort(startDate)} – ${fmtDateShort(endDate)}` : 'All upcoming',
            render: () => (
                <DateRangePicker startDate={startDate} endDate={endDate} onChange={handleDateRangeChange} />
            ),
        }]),
        {
            id: 'area',
            label: 'Area',
            icon: <img src="/map.png" alt="" className="h-4 w-4" />,
            group: 'Search profile',
            groupVariant: 'boxed' as const,
            summary: areaSummary,
            preview: effectiveArea && areaChipState.kind !== 'show-all'
                ? <AreaMapPreview area={effectiveArea} className="h-10 w-14" />
                : undefined,
            groupHeaderAction: signedIn ? (
                <button
                    type="button"
                    onClick={() => setSearchProfileStep('picker')}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-ink hover:text-action"
                    data-testid="search-profile-selector"
                >
                    <span className="truncate">
                        {matchedSearchProfile ? matchedSearchProfile.label : 'Current search'}
                    </span>
                    <span aria-hidden="true" className="shrink-0">▾</span>
                </button>
            ) : undefined,
            render: () => (
                <AreaEditor
                    value={areaChipState.kind === 'show-all' ? null : effectiveArea}
                    myArea={prefs.area ?? DEFAULT_AREA_BBOX}
                    myAreaLabel={prefs.area?.label}
                    profileAreas={signedIn ? searchProfiles : null}
                    onUseArea={handleApplyAreaFromSheet}
                    onExploreMap={handleExploreAreaFromSheet}
                    eventCount={explorerMatchingEvents.length}
                />
            ),
        },
        ...(danceGroup ? [{
            id: 'dance',
            label: 'Dance styles',
            icon: <img src="/dance.png" alt="" className="h-4 w-4" />,
            group: 'Search profile',
            groupVariant: 'boxed' as const,
            summary: groupSummary(danceGroup, 'Any'),
            render: () => renderGroupPills(danceGroup),
        }] : []),
        ...(reachGroup ? [{
            id: 'reach',
            label: 'Event reach',
            icon: <img src="/scale.png" alt="" className="h-4 w-4" />,
            group: 'Search profile',
            groupVariant: 'boxed' as const,
            summary: REACH_FILTER_LABELS[reachFilter],
            render: renderReachFilter,
        }] : []),
        // Small secondary "Save" text action — shown only while the current
        // Area + Dance + Reach combination matches no saved profile.
        ...(signedIn && selectedSearchProfileId === 'custom' ? [{
            id: 'profile-save',
            label: 'Save',
            group: 'Search profile',
            groupVariant: 'boxed' as const,
            summary: '',
            customRow: (
                <div className="flex justify-end px-4 py-2">
                    <button
                        type="button"
                        onClick={() => setSearchProfileStep('save')}
                        className="text-xs font-medium text-action hover:opacity-80"
                        data-testid="search-profile-save-action"
                    >
                        Save profile
                    </button>
                </div>
            ),
        }] : []),
        {
            id: 'people',
            label: 'People',
            icon: <img src="/high-five.png" alt="" className="h-4 w-4" />,
            group: 'Other filters',
            summary: peopleSummary,
            preview: (interestSource !== null || interestUserHandles.length > 0) ? (
                <div className="flex items-center gap-2">
                    {interestUserHandles.length > 0 && (
                        <PeopleAvatarTrack people={interestUserPeople} total={interestUserHandles.length} max={3} size="md" />
                    )}
                    <span className="text-xs font-medium text-ink-soft">
                        {interestKind === 'going' ? 'Going' : interestKind === 'saved' ? 'Interested' : 'Both'}
                    </span>
                </div>
            ) : undefined,
            headerAction: (
                <button
                    type="button"
                    onClick={handleClearPeople}
                    className="text-sm font-medium text-action hover:opacity-80"
                    data-testid="people-reset"
                >
                    Clear
                </button>
            ),
            render: () => renderInterestFilters(),
        },
        ...(formatGroup ? [{
            id: 'format',
            label: 'Event format',
            icon: <img src="/category.png" alt="" className="h-4 w-4" />,
            group: 'Other filters',
            summary: groupSummary(formatGroup, 'Any'),
            badge: groupSelCount(formatGroup) || undefined,
            render: () => renderGroupPills(formatGroup),
        }] : []),
        ...(moreGroups.length > 0 ? [{
            id: 'more',
            label: 'More filters',
            icon: <img src="/more.png" alt="" className="h-4 w-4" />,
            group: 'Other filters',
            summary: (() => {
                const n = moreGroups.reduce((acc, g) => acc + groupSelCount(g), 0);
                return n > 0 ? `${n} selected` : 'None';
            })(),
            badge: moreGroups.reduce((acc, g) => acc + groupSelCount(g), 0) || undefined,
            render: () => (
                <MoreFiltersEditor
                    groups={moreGroups}
                    renderGroup={renderGroupPills}
                    selCount={groupSelCount}
                    summary={(g) => groupSummary(g, 'Any')}
                    groupIcons={moreGroupIcons}
                />
            ),
        }] : []),
    ];

    const renderFilterSummaryBar = (opts?: { className?: string }) => {
        const isCal = viewMode === 'calendar';
        const count = isCal ? calendarVisibleEvents.length : explorerMatchingEvents.length;
        return (
            <SummaryBar
                className={opts?.className}
                totalCount={count}
                visibleCount={count}
                startDate={isCal ? calendarSummaryRange.startDate : startDate}
                endDate={isCal ? calendarSummaryRange.endDate : endDate}
                onEditPeriod={isCal ? undefined : () => openFilterSheet('dates')}
                areaLabel={
                    areaChipState.kind === 'map-view' ? 'Current map view'
                        : areaChipState.kind === 'show-all' ? '🌐'
                            : areaChipState.label
                }
                areaKind={areaChipState.kind}
                areaIsDefault={areaChipState.kind === 'default' && !areaSessionOverride}
                onClearArea={handleClearAreaOverride}
                onEditArea={() => openFilterSheet('area')}
                activeTagIds={activeTagIds}
                tagGroups={tagGroups}
                danceGroup={danceGroup}
                onEditDance={() => openFilterSheet('dance')}
                reachGroup={reachGroup}
                reachFilter={reachFilter}
                onEditReach={() => openFilterSheet('reach')}
                interestSource={interestSource}
                interestKind={interestKind}
                interestUserHandles={interestUserHandles}
                interestUserPeople={interestUserPeople}
                interestMatch={interestMatch}
                onEditPeople={() => openFilterSheet('people')}
                loading={loading}
                onOpenFilters={() => openFilterSheet(null)}
            />
        );
    };

    // Trending trail rendered at the top of the results list (both the
    // desktop left column and the mobile list) instead of above the map.
    const trendingBanner = showTrendingBanner ? (
        <TrendingEventsBanner
            events={explorerMatchingEvents}
            onEventClick={handleExplorerListEventClick}
            showPopularity={showPopularity && trendingEnabled}
            popularityThreshold={popularityThreshold}
            trendingTopN={trendingTopN}
            trendingTopPercent={trendingTopPercent}
            hoveredEventId={railHoveredEventId}
            onEventHover={handleRailEventHover}
            followingBadgeEnabled={followingBadgeEnabled}
        />
    ) : undefined;

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-2 sm:py-4">
                {loading && !initialLoadDone.current && (
                    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted" role="status" aria-live="polite">
                        <div className="h-6 w-6 border-2 border-line border-t-blue-500 animate-spin" aria-hidden="true" />
                        <span className="text-sm">Loading events…</span>
                    </div>
                )}
                {error && (
                    <p className="text-center text-danger">Error: {error}</p>
                )}
                {(!loading || initialLoadDone.current) && !error && (
                    <>
                        <div className="sticky top-0 z-40 bg-canvas">
                            {renderFilterSummaryBar()}
                        </div>
                    </>
                )}
                {(!loading || initialLoadDone.current) && !error && viewMode === 'explorer' && (
                    <div className="mt-1 lg:mt-1">
                        <div className="flex flex-col lg:flex-row gap-1 lg:gap-6 lg:items-start p-0 lg:p-3">
                            {/* Left column: mobile summary + desktop list. Hidden
                                entirely on mobile (its only content is desktop-only)
                                so it doesn't add an empty flex gap above the map column. */}
                            <div className="hidden lg:order-1 lg:flex lg:w-[350px] lg:shrink-0 lg:flex-col lg:gap-4 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6">
                                {/* Event list: fills remaining height on desktop */}
                                <div className="lg:flex lg:flex-col lg:flex-1 lg:min-h-0 lg:overflow-hidden">
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
                                            onEventHover={handleExplorerListEventHover}
                                            onMarkSeen={markSeen}
                                            onSuggestEvent={() => setShowSuggestModal(true)}
                                            newEnabled={unseenStateEnabled}
                                            newEventIds={newEventIds}
                                            onExtendPeriod={handleExtendPeriod}
                                            onClearFilters={handleClearAllFilters}
                                            extendingPeriod={extendingPeriod}
                                            scopeTotalCount={explorerMatchingEvents.length}
                                            nextPeriodEventCount={nextAvailableEventBatch === undefined ? undefined : nextAvailableEventBatch?.matchingCount ?? 0}
                                            gateMoreEventsForAnonymous
                                            tagsAsBadge
                                            tribeCard={config.cardVariant === 'tribe'}
                                            headerSlot={trendingBanner}
                                        />
                                    </div>
                                </div>
                            </div>
                            {/* Map column: desktop only (lg) or mobile fullscreen. Mobile
                                non-fullscreen shows view CTAs instead of miniature. */}
                            {(isDesktop || mapFullscreen) && (
                                <div className="order-2 lg:order-2 lg:flex-1 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6 lg:relative flex flex-col gap-2 sm:gap-2 min-w-0">
                                    <div
                                        className={
                                            mapFullscreen
                                                ? 'explorer-map-shell fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] md:bottom-0 top-[calc(64px+env(safe-area-inset-top))] z-[8000] bg-surface overflow-hidden flex flex-col'
                                                : 'explorer-map-shell relative h-[270px] sm:h-[331px] lg:h-auto lg:flex-1 lg:min-h-0 overflow-hidden flex flex-col'
                                        }
                                        data-testid="explorer-map-shell"
                                        data-fullscreen={mapFullscreen ? 'true' : 'false'}
                                    >
                                        <div className="relative flex min-h-0 flex-1">
                                            <EventMap
                                                events={explorerMatchingEvents}
                                                focusedEvent={mapFullscreen && !isDesktop ? selectedExplorerMapEvent : undefined}
                                                onEventClick={handleExplorerMapEventClick}
                                                onBoundsChange={handleBoundsChange}
                                                hoveredEventId={hoveredEventId}
                                                onEventHover={handleEventHover}
                                                detailLinkSource="explorer-map"
                                                autoFitToken={mapAutoFitToken}
                                                flyToArea={flyToAreaBbox}
                                                flyToAreaToken={flyToAreaToken}
                                                initialArea={resolvedInitialArea}
                                                preserveViewport={preserveViewportAfterSearch}
                                                newEventIds={newEventIds}
                                                popularityThreshold={popularityThreshold}
                                                onMarkSeen={markSeen}
                                                disablePopups={!isDesktop}
                                                onMarkerSelect={!isDesktop ? handleExplorerMapMarkerSelect : undefined}
                                                showFollowingBadgeOverlay={mapFollowingBadgeOverlay}
                                                showTrendingOverlay={mapTrendingOverlay}
                                                compact={false}
                                            />
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
                                                    className={`absolute left-1/2 -translate-x-1/2 z-[703] inline-flex items-center gap-1 border border-blue-200 bg-blue-50 hover:bg-blue-100 text-action text-xs font-semibold px-3 py-1.5 shadow-md transition ${mapFullscreen && !isDesktop ? 'top-14' : 'top-2'}`}
                                                    data-testid="map-search-this-area"
                                                >
                                                    Search this area
                                                </button>
                                            )}
                                            {/* Fullscreen toggle — desktop only. On
                                    mobile the miniature opens the map and the
                                    header / View-list controls exit it. */}
                                            {isDesktop && (
                                                <button
                                                    type="button"
                                                    onClick={() => setMapFullscreen((v) => !v)}
                                                    aria-label={mapFullscreen ? 'Exit fullscreen map' : 'Open fullscreen map'}
                                                    title={mapFullscreen ? 'Exit fullscreen' : 'Fullscreen map'}
                                                    className="absolute top-2 right-2 z-[702] inline-flex h-8 w-8 items-center justify-center border border-line bg-surface text-ink hover:bg-canvas shadow-sm transition"
                                                    data-testid="map-fullscreen-toggle"
                                                >
                                                    {mapFullscreen ? '×' : '⤢'}
                                                </button>
                                            )}
                                            {mapFullscreen && !isDesktop && (
                                                <div className="absolute top-0 inset-x-0 z-[702] flex items-center bg-surface/95 backdrop-blur" data-testid="map-fullscreen-header">
                                                    {renderFilterSummaryBar({ className: 'flex-1 min-w-0' })}
                                                </div>
                                            )}
                                        </div>
                                        {mapFullscreen && !isDesktop && explorerPreviewEvent && (
                                            <MyEventsMapPreview
                                                event={explorerPreviewEvent}
                                                hasPrevious={explorerPreviewIndex > 0}
                                                hasNext={explorerPreviewIndex < explorerMatchingEvents.length - 1}
                                                onPrevious={() => stepExplorerMapPreview(-1)}
                                                onNext={() => stepExplorerMapPreview(1)}
                                                onOpen={() => handleExplorerMapEventClick(explorerPreviewEvent)}
                                                showAvatars
                                                showTags
                                                showReviews
                                                showRatings={!!showRatings}
                                                followingBadgeEnabled={followingBadgeEnabled}
                                            />
                                        )}
                                    </div>
                                    {/* Map footer: quick area presets + off-map
                                    metric + settings shortcut. */}
                                    <div
                                        className="shrink-0 flex items-center gap-1 sm:gap-2 px-1.5 sm:px-2 py-0.5 sm:py-1 border bg-slate-100 border-line text-ink text-xs min-w-0 lg:absolute lg:bottom-0 lg:left-0 lg:right-0 lg:z-[703]"
                                        data-testid="area-default-bar"
                                    >
                                        <div className="relative">
                                            <button
                                                type="button"
                                                onClick={() => setAreaPresetMenuOpen((open) => !open)}
                                                className="shrink-0 whitespace-nowrap px-1.5 py-px border border-line bg-surface text-[11px] opacity-80 hover:opacity-100"
                                                title="Choose your area"
                                                data-testid="area-preset-menu-toggle"
                                                aria-haspopup="menu"
                                                aria-expanded={areaPresetMenuOpen}
                                            >
                                                Your profile area ▾
                                            </button>
                                            {areaPresetMenuOpen && (
                                                <div
                                                    className="absolute left-0 bottom-full mb-1 z-[705] min-w-40 border border-line bg-surface shadow-md"
                                                    role="menu"
                                                    data-testid="area-preset-menu"
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setAreaPresetMenuOpen(false);
                                                            applyDefaultAreaInPlace();
                                                        }}
                                                        className="block w-full border-b border-card-line px-2 py-1 text-left text-[11px] text-ink hover:bg-canvas"
                                                        role="menuitem"
                                                        data-testid="area-snap-default"
                                                    >
                                                        Your profilearea
                                                    </button>
                                                    {AREA_PRESETS.map((preset) => (
                                                        <button
                                                            key={preset.label}
                                                            type="button"
                                                            onClick={() => {
                                                                setAreaPresetMenuOpen(false);
                                                                if (preset.label === 'Worldwide') {
                                                                    applyWorldwideInPlace();
                                                                    return;
                                                                }
                                                                applyPresetAreaInPlace(preset);
                                                            }}
                                                            className="block w-full border-b border-card-line px-2 py-1 text-left text-[11px] text-ink hover:bg-canvas last:border-b-0"
                                                            role="menuitem"
                                                            data-testid={`area-preset-${preset.label.toLowerCase().replace(/\s+/g, '-')}`}
                                                        >
                                                            {preset.label === 'Worldwide' ? '🌐' : preset.label}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <Link
                                            to="/account#preferences"
                                            title="Open preferences"
                                            aria-label="Open preferences"
                                            className="shrink-0 inline-flex h-6 w-6 items-center justify-center opacity-70 hover:opacity-100"
                                            data-testid="map-footer-settings-link"
                                        >
                                            <img src="/setting.png" alt="" aria-hidden="true" className="h-4 w-4 object-contain" />
                                        </Link>
                                        {explorerOffMapCount > 0 && (
                                            <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-ink-soft" data-testid="map-footer-off-map-count">
                                                {explorerOffMapCount} off map
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}
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
                                    onEventHover={handleExplorerListEventHover}
                                    onMarkSeen={markSeen}
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
                                    tagsAsBadge
                                    tribeCard={config.cardVariant === 'tribe'}
                                    headerSlot={trendingBanner}
                                />
                            </div>
                        </div>
                    </div>
                )}
                {(!loading || initialLoadDone.current) && !error && viewMode === 'calendar' && (
                    <CalendarMapWorkspace
                        events={filteredEvents}
                        viewMode={calendarViewMode}
                        onViewModeChange={setMobileCalendarView}
                        rangeSelector="mobile"
                        sinceDate={sinceDate ?? undefined}
                        onDatesChange={handleDatesChange}
                        onEventClick={handleEventClick}
                        hoveredEventId={hoveredEventId}
                        onEventHover={handleEventHover}
                        offMapEventIds={offMapEventIds}
                        map={(calendarVisible) => (
                            <EventMap
                                key={String(calendarVisible)}
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
                        )}
                    />
                )}
            </main>

            <ViewSwitcher currentView={activeView} onSelect={handleSelectView} />

            {/* Overlay modal — calendar mode mobile + explorer (both breakpoints) */}
            {selectedEvent && (viewMode === 'explorer' || (viewMode === 'calendar' && !isDesktop)) && (
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
            {viewMode === 'calendar' ? (
                <FilterSheet
                    open={filterSheetOpen}
                    onClose={() => setFilterSheetOpen(false)}
                    sections={explorerFilterSections}
                    initialSectionId={filterSheetSection}
                    onReset={handleResetFilters}
                    onClearAll={handleClearCalendarFilters}
                    activeFilterCount={calendarActiveFilterCount}
                    matchingEventCount={calendarVisibleEvents.length}
                    variant={isDesktop ? 'modal' : 'sheet'}
                />
            ) : (
                <FilterSheet
                    open={filterSheetOpen}
                    onClose={() => setFilterSheetOpen(false)}
                    sections={explorerFilterSections}
                    initialSectionId={filterSheetSection}
                    onReset={handleResetFilters}
                    onClearAll={handleClearAllFilters}
                    activeFilterCount={activeFilterCount}
                    matchingEventCount={explorerMatchingEvents.length}
                    variant={isDesktop ? 'modal' : 'sheet'}
                />
            )}
            {signedIn && searchProfileStep && (
                <SearchProfileFlow
                    open
                    initialStep={searchProfileStep}
                    onClose={() => setSearchProfileStep(null)}
                    variant={isDesktop ? 'modal' : 'sheet'}
                    profiles={searchProfiles}
                    selectedProfileId={selectedSearchProfileId}
                    current={{ area: effectiveArea, danceIds: danceTagIds, reachFilter, reachIds: reachTagIds }}
                    currentAreaLabel={areaSummary}
                    danceGroup={danceGroup}
                    reachGroup={reachGroup}
                    onApplyProfile={handleApplySearchProfile}
                    onUpdateProfile={handleUpdateProfile}
                    createProfile={createProfile}
                    updateProfile={updateProfile}
                    deleteProfile={deleteProfile}
                />
            )}
        </div>
    );
}

export default function Home() {
    return <ExplorerView config={EXPLORER_CONFIG} />;
}

export function TribeCalendarsView() {
    return <ExplorerView config={TRIBE_CONFIG} />;
}
