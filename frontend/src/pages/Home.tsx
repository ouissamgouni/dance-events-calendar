import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { CalendarEvent, TagGroup } from '../types';
import { fetchEvents, fetchMyFriends, fetchSettings, fetchTagGroups } from '../api';
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
import EventListPanel from '../components/EventListPanel';
import TagFilterPills from '../components/TagFilterPills';
import AreaFilterChip from '../components/AreaFilterChip';
import { usePreferences } from '../context/PreferencesContext';
import { DEFAULT_AREA_BBOX, DEFAULT_AREA_LABEL, clampArea, isDefaultArea } from '../constants/area';
import type { PreferredAreaPayload } from '../api';
import MineButton from '../components/MineButton';
import SuggestEventModal from '../components/SuggestEventModal';
import EventAnchoredDetailPanel from '../components/EventAnchoredDetailPanel';

type ViewMode = 'explorer' | 'calendar';

function formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export default function Home() {
    const { user } = useAuth();
    const { showPrices, showPopularity, popularityThreshold, tagSortMode } = useFeatureFlags();
    const [showSuggestModal, setShowSuggestModal] = useState(false);
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();

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
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [sinceDate, setSinceDate] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
    const [selectedEventSource, setSelectedEventSource] = useState<string | null>(null);
    const [editingEventId, setEditingEventId] = useState<string | null>(null);
    const [sortBy, setSortBy] = useState<'date' | 'popularity'>('date');
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [activeTagIds, setActiveTagIds] = useState<Set<number>>(new Set());
    // Tracks whether the user has manually toggled a tag in this session.
    // While false, we still mirror late-arriving pref changes (e.g. after
    // sign-in hydrates server prefs) into ``activeTagIds`` so the explorer
    // immediately reflects the user's saved defaults. After a manual toggle
    // we stop syncing so the user keeps control.
    const userTouchedTagsRef = useRef(false);

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
        // Hydrate tag filter from URL on mount; if absent, fall back to saved
        // prefs. URL takes precedence so shared links always render exactly
        // as the sender intended.
        const urlTags = searchParams.get('tag_ids');
        if (urlTags) {
            const ids = urlTags
                .split(',')
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n) && n > 0);
            if (ids.length) {
                setActiveTagIds(new Set(ids));
                userTouchedTagsRef.current = true; // URL is an explicit choice
            }
        } else if (prefs.tagIds.length) {
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

    // Explorer mode fetches the full event set (worldwide) and filters by
    // the current map viewport on the client — the catalogue is small
    // enough that a per-pan API roundtrip isn't worth it, and this way
    // panning instantly reveals the events under the new viewport without
    // a refetch round-trip or relying on a server-side bbox match.

    // Chip state. Four user-visible cases:
    //   • 'map-view'  — user has panned/zoomed; results follow viewport
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
    const today = formatDate(new Date());
    const defaultEndDate = new Date();
    defaultEndDate.setMonth(defaultEndDate.getMonth() + 6);
    const [startDate, setStartDate] = useState(today);
    const [endDate, setEndDate] = useState(formatDate(defaultEndDate));

    // Friend filter (Phase B). Anonymous users can toggle the chip but the
    // backend returns an empty list — the UI surfaces a sign-in nudge in that
    // case so the empty state isn't confusing.
    //
    // "Interested" is the union of going + saved (Facebook Events semantics):
    // a single toggle sends both ``friends_going`` and ``friends_saved`` to
    // the backend, which OR-merges them.
    const [friendsInterested, setFriendsInterested] = useState(false);
    // Optional: scope the Interested filter to one specific friend. When set,
    // implies ``friendsInterested = true`` (a friend is selected because the
    // viewer wants to see their picks).
    const [friendHandle, setFriendHandle] = useState<string | null>(null);

    // Calendar mode map bounds (for off-map styling in the calendar grid)
    const [calMapBounds, setCalMapBounds] = useState<MapBounds | null>(null);

    const navigate = useNavigate();

    // Cross-component hover highlight
    const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
    const handleEventHover = useCallback((eventId: string | null) => {
        setHoveredEventId(eventId);
    }, []);

    // CalendarEvents query source:
    //  • If the user has panned/zoomed (``userMapBounds`` set), follow that viewport.
    //  • Otherwise use the configured area (preset / saved / default).
    // This keeps Default/Europe/World clicks from picking up extra events
    // outside the requested area when the map's aspect ratio forces a
    // wider visible viewport than the bbox.
    const initialLoadDone = useRef(false);
    const [visibleRange, setVisibleRange] = useState<{ start: Date; end: Date } | null>(null);
    useEffect(() => {
        if (!initialLoadDone.current) setLoading(true);
        let params: { startDate?: string; endDate?: string; area?: PreferredAreaPayload | null; friendsGoing?: boolean; friendsSaved?: boolean; friendHandle?: string } | undefined;
        if (viewMode === 'explorer') {
            // No ``area`` here on purpose — we always pull the full set
            // and filter by the current map viewport on the client (see
            // ``filteredEvents``). Keeps panning instantaneous regardless
            // of which preset is selected.
            const interestedActive = friendsInterested || !!friendHandle;
            params = {
                startDate,
                endDate,
                friendsGoing: interestedActive || undefined,
                friendsSaved: interestedActive || undefined,
                friendHandle: friendHandle ?? undefined,
            };
        } else if (visibleRange) {
            params = {
                startDate: formatDate(visibleRange.start),
                endDate: formatDate(visibleRange.end),
            };
        } else {
            // Calendar mode initial load: use same default as explorer
            params = { startDate, endDate };
        }
        const tagParams = params?.startDate || params?.endDate ? params : undefined;
        Promise.all([fetchEvents(params), fetchSettings(), fetchTagGroups(tagParams)])
            .then(([evts, settings, groups]) => {
                setEvents(evts);
                setSinceDate(settings.since_date);
                setTagGroups(groups);
            })
            .catch((e) => setError(e.message))
            .finally(() => {
                setLoading(false);
                initialLoadDone.current = true;
            });
    }, [viewMode, startDate, endDate, visibleRange, friendsInterested, friendHandle]);

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

    const filteredEvents = useMemo(() => {
        // Step 1: viewport filter (explorer only). The bbox we filter by:
        //  • If the user has panned/zoomed (``userMapBounds`` set), use
        //    that — they're driving the viewport.
        //  • Else, use the configured ``effectiveArea`` (preset / saved /
        //    default). NOT the live ``mapBounds`` — on mobile the map's
        //    aspect ratio forces Leaflet to display a viewport noticeably
        //    wider than the requested bbox, which would otherwise pull in
        //    e.g. Asian events when the user picked "Europe".
        //  • Worldwide opt-out (``effectiveArea === null`` and no
        //    user pan) skips the filter entirely.
        // Events without coordinates always pass through.
        let base = events;
        if (viewMode === 'explorer') {
            const filterBbox: { south: number; north: number; west: number; east: number } | null =
                userMapBounds
                    ? userMapBounds
                    : effectiveArea
                        ? {
                            south: effectiveArea.min_lat,
                            north: effectiveArea.max_lat,
                            west: effectiveArea.min_lng,
                            east: effectiveArea.max_lng,
                        }
                        : null;
            if (filterBbox) {
                const b = filterBbox;
                base = events.filter((e) => {
                    if (e.latitude == null || e.longitude == null) return true;
                    return (
                        e.latitude >= b.south &&
                        e.latitude <= b.north &&
                        e.longitude >= b.west &&
                        e.longitude <= b.east
                    );
                });
            }
        }
        if (activeTagIds.size === 0) return base;

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

        return base.filter((e) => {
            const tagSet = new Set((e.tags ?? []).map((t) => t.id));
            for (const ids of groupBuckets.values()) {
                if (!ids.some((id) => tagSet.has(id))) return false;
            }
            for (const id of ungrouped) {
                if (!tagSet.has(id)) return false;
            }
            return true;
        });
    }, [events, activeTagIds, tagGroups, viewMode, userMapBounds, effectiveArea]);

    // Disjunctive facet counts.
    //
    // Filter semantics (must match `filteredEvents` above):
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

        const eventTagSets = events.map((e) => new Set((e.tags ?? []).map((t) => t.id)));

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
    }, [events, tagGroups, activeTagIds]);

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
        navigate(`/event/${evt.event_id}?src=explorer-list`);
    }, [navigate]);

    // Explorer map marker click — carries source through URL query param
    const handleExplorerMapEventClick = useCallback((evt: CalendarEvent) => {
        navigate(`/event/${evt.event_id}?src=explorer-map`);
    }, [navigate]);

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
        const params = viewMode === 'explorer'
            ? { startDate, endDate }
            : visibleRange
                ? { startDate: formatDate(visibleRange.start), endDate: formatDate(visibleRange.end) }
                : { startDate, endDate };
        fetchEvents(params).then(setEvents).catch(() => { });
    }, [viewMode, startDate, endDate, visibleRange]);

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
        return mid.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }, [visibleRange]);

    return (
        <div className="min-h-screen bg-[#f8fafc]">
            <main className="mx-auto max-w-7xl px-4 py-4">
                {!loading && !error && (
                    <div className="mb-4 flex flex-col gap-2">
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
                        <div className="flex flex-col lg:flex-row gap-6 lg:items-start">
                            {/* Left column: filters + list */}
                            <div className="order-1 lg:order-1 lg:w-[350px] lg:shrink-0 flex flex-col gap-4 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6">
                                <DateRangePicker
                                    startDate={startDate}
                                    endDate={endDate}
                                    onChange={handleDateRangeChange}
                                />
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
                                                data-testid="save-tags-as-default"
                                            >
                                                {savingDefaults ? 'Saving…' : 'current as default'}
                                            </button>
                                        ) : undefined}
                                    />
                                )}
                                {/* Friend filter chips (Phase B). Only useful for
                                signed-in users with mutual followers; the
                                backend returns an empty list for anonymous
                                viewers, which we surface explicitly below. */}
                                <FriendFilterChips
                                    signedIn={!!user}
                                    friendsInterested={friendsInterested}
                                    onToggleInterested={() => {
                                        bumpAutoFit();
                                        setFriendsInterested((v) => {
                                            // Turning the chip off also clears
                                            // any selected friend — otherwise
                                            // the dropdown would show a stale
                                            // selection while the filter is
                                            // visually inactive.
                                            if (v) setFriendHandle(null);
                                            return !v;
                                        });
                                    }}
                                    friendHandle={friendHandle}
                                    onFriendHandleChange={(h) => {
                                        bumpAutoFit();
                                        setFriendHandle(h);
                                        if (h) setFriendsInterested(true);
                                    }}
                                />
                                {/* Event list: hidden on mobile until after map, fills remaining height on desktop */}
                                <div className="hidden lg:block lg:flex-1 lg:min-h-0 lg:overflow-hidden">
                                    <EventListPanel
                                        events={filteredEvents}
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
                                    />
                                </div>
                            </div>
                            {/* Map column: map + default-location bar stacked.
                            On mobile this is order-2 (between left filters
                            and event list). On desktop the column is sticky
                            and fills available height; the bar is shrink-0
                            so it doesn't get clipped. */}
                            <div className="order-2 lg:order-2 lg:flex-1 lg:h-[calc(100vh-140px)] lg:sticky lg:top-6 flex flex-col gap-2 min-w-0">
                                <div className="h-[180px] lg:h-auto lg:flex-1 lg:min-h-0">
                                    <EventMap
                                        events={filteredEvents}
                                        onEventClick={handleExplorerMapEventClick}
                                        onBoundsChange={handleBoundsChange}
                                        hoveredEventId={hoveredEventId}
                                        onEventHover={handleEventHover}
                                        detailLinkSource="explorer-map"
                                        autoFitToken={mapAutoFitToken}
                                        flyToArea={flyToAreaBbox}
                                        flyToAreaToken={flyToAreaToken}
                                        initialArea={initialAreaRef.current}
                                    />
                                </div>
                                {/* Default-area bar: ONE bordered pill that
                                visually groups the chip label + worldwide /
                                reset toggle + save-as-default link, so the
                                user reads it as a single "this is the area
                                being applied, here's what you can do with
                                it" unit. */}
                                <div
                                    className="shrink-0 flex flex-col gap-1 px-2 py-1 border bg-slate-100 border-slate-200 text-slate-700 text-xs min-w-0"
                                    data-testid="area-default-bar"
                                >
                                    <div className="flex flex-wrap items-center gap-2 min-w-0">
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
                            {/* Event list on mobile: order-3, hidden on desktop */}
                            <div className="order-3 lg:hidden">
                                <EventListPanel
                                    events={filteredEvents}
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
                            <div className="flex items-center gap-2">
                                <div className="flex">
                                    <button className="px-2 py-1 text-sm border border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalPrev}>‹</button>
                                    <button className="px-2.5 py-1 text-sm border-y border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalToday}>today</button>
                                    <button className="px-2 py-1 text-sm border border-slate-300 bg-white hover:bg-slate-50" onClick={handleCalNext}>›</button>
                                </div>
                                <h2 className="text-sm sm:text-lg font-semibold text-slate-800 whitespace-nowrap">{calendarTitle}</h2>
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
                        {tagGroups.length > 0 && (
                            <div className="mb-4">
                                <TagFilterPills
                                    tagGroups={tagGroups}
                                    activeTagIds={activeTagIds}
                                    onToggle={handleToggleTag}
                                    onClear={handleClearTags}
                                    countOverrides={tagCountMap}
                                    sortMode={tagSortMode}
                                />
                            </div>
                        )}
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
        </div>
    );
}

function FriendFilterChips({
    signedIn,
    friendsInterested,
    onToggleInterested,
    friendHandle,
    onFriendHandleChange,
}: {
    signedIn: boolean;
    friendsInterested: boolean;
    onToggleInterested: () => void;
    friendHandle: string | null;
    onFriendHandleChange: (h: string | null) => void;
}) {
    // Pill styling matches TagFilterPills (square corners per UI conventions).
    const chip = (active: boolean) =>
        'px-2 py-1 text-xs border transition ' +
        (active
            ? 'bg-blue-500 border-blue-500 text-white'
            : 'bg-white border-slate-200 text-slate-600 hover:border-blue-500 hover:text-blue-500');
    // Lazily fetch the viewer's friends only when the picker is needed,
    // i.e. once Interested is toggled on. Anonymous users never trigger this.
    const [friends, setFriends] = useState<{ handle: string; display_name: string | null }[]>([]);
    const [friendsLoaded, setFriendsLoaded] = useState(false);
    useEffect(() => {
        if (!signedIn || !friendsInterested || friendsLoaded) return;
        let cancelled = false;
        fetchMyFriends({ limit: 100 })
            .then((res) => {
                if (cancelled) return;
                setFriends(res.items.map((f) => ({ handle: f.handle, display_name: f.display_name })));
                setFriendsLoaded(true);
            })
            .catch(() => {
                if (!cancelled) setFriendsLoaded(true);
            });
        return () => { cancelled = true; };
    }, [signedIn, friendsInterested, friendsLoaded]);
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">
                Friends
            </span>
            <button
                type="button"
                onClick={onToggleInterested}
                className={chip(friendsInterested)}
                aria-pressed={friendsInterested}
                disabled={!signedIn}
                title={signedIn ? "Show events your friends are going to or have saved" : 'Sign in to filter by friends'}
            >
                Interested
            </button>
            {signedIn && friendsInterested && (
                <select
                    value={friendHandle ?? ''}
                    onChange={(e) => onFriendHandleChange(e.target.value || null)}
                    className="text-xs border border-slate-200 bg-white px-2 py-1 text-slate-700"
                    aria-label="Filter by a specific friend"
                >
                    <option value="">All friends</option>
                    {friends.map((f) => (
                        <option key={f.handle} value={f.handle}>
                            {f.display_name ? `${f.display_name} (@${f.handle})` : `@${f.handle}`}
                        </option>
                    ))}
                </select>
            )}
            {!signedIn && friendsInterested && (
                <span className="text-xs text-slate-500">
                    <Link to="/login" className="text-blue-600 hover:underline">
                        Sign in
                    </Link>{' '}
                    to see your friends' picks.
                </span>
            )}
        </div>
    );
}
