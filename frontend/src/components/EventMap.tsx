import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { MapContainer, Polygon, Rectangle, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import type { CalendarEvent } from '../types';
import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';
import RateEventButton from './RateEventButton';
import TagBadges from './TagBadges';
import AttendeeAvatarStack from './AttendeeAvatarStack';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

export interface MapBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

const EUROPE_CENTER: [number, number] = [48.5, 10.0];
const DEFAULT_ZOOM = 5;
const CITY_ZOOM = 13;

/**
 * Pick a fitBounds padding that won't cause Leaflet to fall back to a much
 * lower zoom (or even zoom 0) on a small container. Leaflet's fitBounds
 * subtracts padding from the available pixels before solving for the zoom
 * that fits the bbox; on a 180px-tall mobile map a [40, 40] padding leaves
 * only 100px usable height which often rounds the result down by 1-2 zoom
 * levels and makes the map look uncomfortably zoomed-out around the
 * markers. Scale padding to ~10% of the container's smallest side, capped.
 */
function adaptiveMarkerPadding(map: L.Map): [number, number] {
    const size = map.getSize();
    const min = Math.min(size.x, size.y);
    if (min <= 0) return [10, 10];
    const p = Math.max(8, Math.min(40, Math.round(min * 0.1)));
    return [p, p];
}

/** Per-event signal overlays composed onto the colored disc. All optional. */
interface PinDecorations {
    /** True when popularity_score is top-3 + above threshold; draws an orange ring. */
    trending?: boolean;
    /** Count of mutual friends with going/saved; draws a rose chip at bottom-right. */
    followingCount?: number;
    /** True when the viewer hasn't opened this event; draws a rose dot at top-right. */
    unseen?: boolean;
    /** Total going count for the event; rendered as a small slate chip at
     * top-left so the pin conveys "how many attendees" even when there are
     * no mutual friends. */
    totalGoing?: number;
}

/** Build the SVG fragment for the trending ring (drawn just inside the box). */
function trendingRing(size: number): string {
    const cx = size / 2;
    const r = size / 2 - 1;
    return `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#f97316" stroke-width="2" />`;
}

/** Build the HTML for the following-friend chip (bottom-right). Blue
 * (social signal, not warning) + an inline "people" silhouette so the
 * count reads as "N people you follow" even at pin size. */
function followingChip(count: number): string {
    const label = count >= 10 ? '9+' : String(count);
    // Inline SVG: 8x8 two-head people glyph in white. Tight against the
    // count for a "icon · N" composition that fits in ~26px width.
    const icon =
        '<svg viewBox="0 0 20 20" width="8" height="8" fill="currentColor" aria-hidden="true" style="vertical-align:middle;margin-right:1px;">' +
        '<path d="M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 16.25c0-2.69 2.46-4.5 5.5-4.5s5.5 1.81 5.5 4.5v.5h-11v-.5Zm12.25.5v-.5c0-1.18-.42-2.2-1.14-3.01.36-.05.74-.07 1.14-.07 2.62 0 4.5 1.45 4.5 3.58Z"/></svg>';
    return `<span style="position:absolute;right:-6px;bottom:-6px;display:inline-flex;align-items:center;min-width:18px;height:14px;padding:0 4px;background:#3b82f6;color:white;font-size:9px;font-weight:700;line-height:14px;border:1.5px solid white;box-sizing:content-box;font-family:system-ui,sans-serif;">${icon}${label}</span>`;
}

/** Build the HTML for the unseen dot (top-right). Blue dot matches the
 * unseen affordance on the cards (`bg-blue-500`). */
function unseenDot(): string {
    return `<span style="position:absolute;right:-2px;top:-2px;width:8px;height:8px;border-radius:9999px;background:#3b82f6;border:1.5px solid white;box-sizing:content-box;"></span>`;
}

/** Build the HTML for the total-going chip (top-left). Slate (neutral)
 * so it reads as "how many" without competing with the friends-going
 * (blue) or unseen (blue) social signals. */
function totalGoingChip(count: number): string {
    const label = count >= 100 ? '99+' : String(count);
    return `<span style="position:absolute;left:-6px;top:-6px;display:inline-flex;align-items:center;justify-content:center;min-width:14px;height:14px;padding:0 3px;background:#475569;color:white;font-size:9px;font-weight:700;line-height:14px;border:1.5px solid white;box-sizing:content-box;font-family:system-ui,sans-serif;">${label}</span>`;
}

function makeColoredIcon(color: string | null, dec?: PinDecorations): L.DivIcon {
    const fill = color || '#3b82f6';
    const ring = dec?.trending ? trendingRing(28) : '';
    const followBadge = dec?.followingCount && dec.followingCount > 0 ? followingChip(dec.followingCount) : '';
    const unseenBadge = dec?.unseen ? unseenDot() : '';
    const totalBadge = dec?.totalGoing && dec.totalGoing > 0 ? totalGoingChip(dec.totalGoing) : '';
    return L.divIcon({
        className: '',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14],
        html: `<div style="position:relative;width:28px;height:28px;"><svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="14" r="11" fill="${fill}" stroke="white" stroke-width="2.5" />
            <circle cx="14" cy="14" r="4" fill="white" opacity="0.9" />
            ${ring}
        </svg>${totalBadge}${unseenBadge}${followBadge}</div>`,
    });
}

function makeHighlightedIcon(color: string | null, dec?: PinDecorations): L.DivIcon {
    const fill = color || '#3b82f6';
    const ring = dec?.trending ? trendingRing(36) : '';
    const followBadge = dec?.followingCount && dec.followingCount > 0 ? followingChip(dec.followingCount) : '';
    const unseenBadge = dec?.unseen ? unseenDot() : '';
    const totalBadge = dec?.totalGoing && dec.totalGoing > 0 ? totalGoingChip(dec.totalGoing) : '';
    return L.divIcon({
        className: '',
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -18],
        html: `<div style="position:relative;width:36px;height:36px;"><svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
            <circle cx="18" cy="18" r="16" fill="${fill}" opacity="0.25" />
            <circle cx="18" cy="18" r="12" fill="${fill}" stroke="white" stroke-width="3" />
            <circle cx="18" cy="18" r="4.5" fill="white" opacity="0.9" />
            ${ring}
        </svg>${totalBadge}${unseenBadge}${followBadge}</div>`,
    });
}

interface Props {
    events: CalendarEvent[];
    focusedEvent?: CalendarEvent | null;
    onEventClick?: (event: CalendarEvent) => void;
    onBoundsChange?: (bounds: MapBounds, userDriven: boolean) => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    /** Source value appended as ?src= on popup "Details" links */
    detailLinkSource?: string;
    /** Optional bounding box to render as a translucent rectangle, used by
     * the explorer to visualise the active preferred-area filter so users
     * understand why events outside it are hidden. Pass ``null`` to omit. */
    areaOverlay?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
    /** Monotonic counter controlled by the parent. The map auto-fits to its
     * markers ONLY when this value changes (and on the very first render).
     * Bump it when the user does something that changes WHAT events are
     * displayed (date, tags, friend filter, area show-all/reset, prefs
     * hydration). Do NOT bump it after "Save as default" — the user already
     * chose the viewport and we mustn't snap it to slightly different
     * marker bounds. */
    autoFitToken?: number;
    /** Optional bbox to fly to imperatively. Combined with
     * ``flyToAreaToken`` (a monotonic counter) so the parent can request a
     * map flyToBounds without re-firing on every render. Used by the
     * "Default area" snap-back action so the map view (and therefore the
     * events query, which now follows the viewport) returns to the user's
     * configured default area. */
    flyToArea?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
    flyToAreaToken?: number;
    /** Optional initial bbox to open the map at, captured ONCE on mount.
     * Avoids the two-step zoom of (a) first marker auto-fit, then (b)
     * imperative flyToArea re-fit. When provided, the marker auto-fit is
     * also suppressed for the first render. */
    initialArea?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
    /** Set of event_ids the viewer has already opened. Drives the Unseen
     * dot overlay when ``unseenStateEnabled`` is on. Optional — when
     * omitted no events are treated as seen. */
    seenEventIds?: Set<string>;
    /** Threshold for the trending pin ring. Defaults to 10 to match the
     * list panel's ``PopularityBadge``. */
    popularityThreshold?: number;
    /** Called when a pin (or its popup title) is clicked; the parent uses
     * this to mark the event as seen. */
    onMarkSeen?: (eventId: string) => void;
    /** Per-render override for the following-badge overlay on map pins.
     * When the site-wide ``followingBadgeEnabled`` flag is on, this lets
     * the user temporarily hide the friends-going chip on the map without
     * disabling the badge elsewhere (cards, modal). Defaults to ``true``.
     * Has no effect when the site-wide flag is off. */
    showFollowingBadgeOverlay?: boolean;
}

function BoundsReporter({ onBoundsChange }: { onBoundsChange?: (bounds: MapBounds, userDriven: boolean) => void }) {
    const map = useMap();
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const userDrivenRef = useRef(false);

    const reportBounds = useCallback(() => {
        if (!onBoundsChange) return;
        const b = map.getBounds();
        const userDriven = userDrivenRef.current;
        userDrivenRef.current = false;
        onBoundsChange({
            north: b.getNorth(),
            south: b.getSouth(),
            east: b.getEast(),
            west: b.getWest(),
        }, userDriven);
    }, [map, onBoundsChange]);

    useEffect(() => {
        const moveend = () => {
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(reportBounds, 300);
        };
        // We mark the NEXT moveend as user-driven by listening for actual
        // input on the map container. Leaflet's ``movestart`` /
        // ``zoomstart`` events don't reliably carry an ``originalEvent``
        // for drag gestures (the drag handler emits them after the
        // gesture has already started internally), so distinguishing
        // programmatic ``fitBounds`` / ``setView`` from real user input
        // by inspecting Leaflet events alone misses real pans. DOM input
        // events on the container fire only for real gestures, never for
        // programmatic moves.
        const container = map.getContainer();
        const markUser = () => { userDrivenRef.current = true; };
        container.addEventListener('pointerdown', markUser);
        container.addEventListener('wheel', markUser, { passive: true });
        container.addEventListener('touchstart', markUser, { passive: true });
        container.addEventListener('keydown', markUser);
        map.on('moveend', moveend);
        // Report initial bounds (not user-driven).
        reportBounds();
        return () => {
            container.removeEventListener('pointerdown', markUser);
            container.removeEventListener('wheel', markUser);
            container.removeEventListener('touchstart', markUser);
            container.removeEventListener('keydown', markUser);
            map.off('moveend', moveend);
            clearTimeout(timerRef.current);
        };
    }, [map, reportBounds]);

    return null;
}

function MapController({
    positions,
    focusedEventId,
    focusedPosition,
    markerRefs,
    autoFitToken,
    flyToAreaToken,
    skipInitialFit,
}: {
    positions: [number, number][];
    focusedEventId: string | null;
    focusedPosition: [number, number] | null;
    markerRefs: MutableRefObject<Map<string, L.Marker>>;
    autoFitToken: number | undefined;
    flyToAreaToken: number | undefined;
    /** When true, suppress the very first marker auto-fit (the parent has
     * already opened the map at a known bbox via ``initialArea``). */
    skipInitialFit: boolean;
}) {
    const map = useMap();
    const prevFocused = useRef<[number, number] | null>(null);
    // Last ``autoFitToken`` value that actually triggered a fit. ``-1``
    // means no fit has happened yet, so the very first render with
    // positions will fit regardless of the token value.
    const lastFitToken = useRef<number>(-1);

    // Focus / un-focus animations — explicit user actions (clicking a list
    // item or closing a popup), so always run them.
    useEffect(() => {
        map.closePopup();

        if (focusedPosition) {
            prevFocused.current = focusedPosition;
            const openPopup = () => {
                if (!focusedEventId) return;
                const marker = markerRefs.current.get(focusedEventId);
                if (marker) marker.openPopup();
            };
            map.once('moveend', openPopup);
            map.flyTo(focusedPosition, CITY_ZOOM, { duration: 0.8 });
            return;
        }

        if (prevFocused.current !== null) {
            prevFocused.current = null;
            if (positions.length === 0) {
                map.flyTo(EUROPE_CENTER, DEFAULT_ZOOM, { duration: 0.8 });
            } else if (positions.length === 1) {
                map.flyTo(positions[0], CITY_ZOOM, { duration: 0.8 });
            } else {
                map.invalidateSize();
                map.flyToBounds(L.latLngBounds(positions), { padding: adaptiveMarkerPadding(map), duration: 0.8 });
            }
        }
    }, [focusedEventId, focusedPosition, map, markerRefs, positions]);

    // Snapshot of the positions key captured at the moment of a token
    // bump. While set, the next *change* in positions is treated as the
    // result of an async refetch triggered by the same user action and
    // gets a follow-up fit. Cleared after that follow-up fit so later
    // unrelated position updates don't override the user's viewport.
    const positionsSnapshotAtBump = useRef<string | null>(null);

    // When the parent issues an imperative flyToArea (Default / Europe /
    // World pills) we want a TWO-STEP behaviour:
    //   1. ``FlyToAreaController`` snaps the map to the requested bbox now
    //      (forces the events query to refetch with that bbox).
    //   2. We then tighten the view to the actual marker bounds — either
    //      after the refetch lands (positions change → branch below), or
    //      right away if positions already match (e.g. clicking the same
    //      preset twice). Much more useful than staying framed on a
    //      continent-sized bbox when events cluster in a few cities.
    const lastFlyToken = useRef<number | undefined>(flyToAreaToken);
    useEffect(() => {
        if (flyToAreaToken === undefined) return;
        if (lastFlyToken.current === flyToAreaToken) return;
        lastFlyToken.current = flyToAreaToken;
        const positionsKey = positions
            .map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`)
            .join('|');
        positionsSnapshotAtBump.current = positionsKey;
        // Schedule a follow-up fit-to-markers a bit after the area fit, so
        // even when the events query doesn't refetch (same area, same
        // results) we still tighten around the existing markers. Skipped
        // when the positions snapshot mechanism below has already fired.
        const timer = setTimeout(() => {
            if (positionsSnapshotAtBump.current !== positionsKey) return; // already consumed
            positionsSnapshotAtBump.current = null;
            if (positions.length === 0) return;
            if (positions.length === 1) {
                map.setView(positions[0], CITY_ZOOM);
            } else {
                map.invalidateSize();
                map.fitBounds(L.latLngBounds(positions), { padding: adaptiveMarkerPadding(map), animate: false });
            }
        }, 600);
        return () => clearTimeout(timer);
    }, [flyToAreaToken, positions, map]);

    // Auto-fit to markers. In controlled mode (``autoFitToken !== undefined``)
    // this runs when the parent bumps the token (or on the very first
    // render). It additionally re-fits ONCE when positions change after a
    // bump so async refetches (e.g. switching to worldwide) actually update
    // the viewport instead of the fit happening with stale markers. In
    // legacy mode (token undefined) it refits on every positions change —
    // used by calendar surfaces where the event set changes via month nav
    // and a refit is always desired.
    useEffect(() => {
        if (focusedPosition) return; // focus effect is in charge

        const positionsKey = positions
            .map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`)
            .join('|');

        let shouldFit = false;
        if (autoFitToken === undefined) {
            shouldFit = true; // legacy mode
        } else if (lastFitToken.current === -1) {
            // First render with controlled mode.
            // When the parent provides an ``initialArea`` (map opened at
            // that bbox) or is also issuing an imperative ``flyToArea``
            // (token > 0), skip the initial marker-fit — the area bbox
            // takes precedence so the user gets the framing they asked for.
            // Still capture the positions snapshot so the FOLLOW-UP refetch
            // (events filtered by the new viewport) tightens around the
            // actual markers.
            lastFitToken.current = autoFitToken;
            positionsSnapshotAtBump.current = positionsKey;
            if (!(skipInitialFit || (flyToAreaToken !== undefined && flyToAreaToken > 0))) {
                shouldFit = true;
            } else {
                // Schedule a follow-up fit-to-markers in case events were
                // already loaded by the time the map mounted (positions
                // never change → snapshot-mismatch branch never fires →
                // map would stay at the area bbox forever instead of
                // tightening). Mirrors the flyToAreaToken effect's
                // 600ms safety net.
                const snapshotKey = positionsKey;
                setTimeout(() => {
                    if (positionsSnapshotAtBump.current !== snapshotKey) return;
                    positionsSnapshotAtBump.current = null;
                    if (positions.length === 0) return;
                    if (positions.length === 1) {
                        map.setView(positions[0], CITY_ZOOM);
                    } else {
                        map.invalidateSize();
                        map.fitBounds(L.latLngBounds(positions), { padding: adaptiveMarkerPadding(map), animate: false });
                    }
                }, 600);
            }
        } else if (lastFitToken.current !== autoFitToken) {
            // Token bumped — fit now with whatever's available and remember
            // the positions snapshot so we can re-fit once a follow-up
            // refetch updates them.
            shouldFit = true;
            lastFitToken.current = autoFitToken;
            positionsSnapshotAtBump.current = positionsKey;
        } else if (
            positionsSnapshotAtBump.current !== null &&
            positionsSnapshotAtBump.current !== positionsKey
        ) {
            // Positions changed after a bump (refetch completed). Refit
            // once and consume the pending snapshot.
            shouldFit = true;
            positionsSnapshotAtBump.current = null;
        }

        if (!shouldFit) return;

        // No events: don't move the map. Auto-fitting to a hardcoded
        // EUROPE_CENTER + DEFAULT_ZOOM here would overwrite the viewport
        // the user is already looking at (e.g. the configured default-area
        // bbox is wider than DEFAULT_ZOOM, so the user would see an
        // unexpected zoom-in just because the period filter happened to
        // return zero events).
        if (positions.length === 0) return;

        if (positions.length === 1) {
            map.setView(positions[0], CITY_ZOOM);
        } else {
            map.invalidateSize();
            map.fitBounds(L.latLngBounds(positions), { padding: adaptiveMarkerPadding(map) });
        }
    }, [autoFitToken, focusedPosition, map, positions]);

    return null;
}

/**
 * Imperative bbox-flyer. Fires ``map.flyToBounds`` exactly once per change
 * of ``flyToAreaToken`` (skipping the initial render). Lives in its own
 * component so the always-running auto-fit logic isn't entangled with
 * snap-back behaviour and a "Default area" click can move the viewport
 * even when no markers exist yet.
 */
function FlyToAreaController({
    flyToArea,
    flyToAreaToken,
}: {
    flyToArea: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null | undefined;
    flyToAreaToken: number | undefined;
}) {
    const map = useMap();
    const lastToken = useRef<number | undefined>(flyToAreaToken);
    useEffect(() => {
        if (flyToAreaToken === undefined) return;
        if (lastToken.current === flyToAreaToken) return;
        lastToken.current = flyToAreaToken;
        if (!flyToArea) return;
        map.stop();
        // Container size may have changed since the last render (e.g. show
        // bar appearing/disappearing); without this, Leaflet's cached size
        // is stale and ``fitBounds`` computes against the wrong viewport
        // and silently picks zoom 0.
        map.invalidateSize();
        map.fitBounds(
            [
                [flyToArea.min_lat, flyToArea.min_lng],
                [flyToArea.max_lat, flyToArea.max_lng],
            ],
            { padding: [0, 0], animate: false },
        );
    }, [flyToAreaToken, flyToArea, map]);
    return null;
}

export default function EventMap({ events, focusedEvent, onEventClick, onBoundsChange, hoveredEventId, onEventHover, detailLinkSource, areaOverlay, autoFitToken, flyToArea, flyToAreaToken, initialArea, seenEventIds, popularityThreshold = 10, onMarkSeen, showFollowingBadgeOverlay = true }: Props) {
    const { showRatings, eventColorBarColor, followingBadgeEnabled, unseenStateEnabled, trendingEnabled, trendingTopN, trendingTopPercent } = useFeatureFlags();
    const markerRefs = useRef(new Map<string, L.Marker>());
    const geoEvents = useMemo(
        () => events.filter((e) => e.latitude != null && e.longitude != null),
        [events],
    );

    // Top-K popularity_score in the currently-rendered set, used (with
    // the threshold) to gate the trending pin ring — mirrors
    // PopularityBadge. Effective cap is
    //   min(trendingTopN, ceil(positiveVisible * trendingTopPercent / 100))
    const topScores = useMemo<number[]>(() => {
        const scores = geoEvents
            .map((e) => e.popularity_score ?? 0)
            .filter((s) => s > 0)
            .sort((a, b) => b - a);
        const cap = Math.max(
            1,
            Math.min(trendingTopN, Math.ceil((scores.length * trendingTopPercent) / 100)),
        );
        return scores.slice(0, cap);
    }, [geoEvents, trendingTopN, trendingTopPercent]);

    const positions = useMemo<[number, number][]>(
        () => geoEvents.map((e) => [e.latitude!, e.longitude!]),
        [geoEvents],
    );

    const focusedPosition = useMemo<[number, number] | null>(() => {
        if (!focusedEvent?.latitude || !focusedEvent?.longitude) return null;
        return [focusedEvent.latitude, focusedEvent.longitude];
    }, [focusedEvent]);

    const focusedEventId = focusedEvent?.event_id ?? null;

    const registerMarker = useCallback((eventId: string, marker: L.Marker | null) => {
        if (marker) {
            markerRefs.current.set(eventId, marker);
            return;
        }
        markerRefs.current.delete(eventId);
    }, []);

    const formatDate = (e: CalendarEvent) => {
        const start = new Date(e.start);
        const date = start.toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
        });
        if (e.all_day) return date;
        const time = start.toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
        });
        return `${date} · ${time}`;
    };

    return (
        <MapContainer
            {...(initialArea
                ? { bounds: [[initialArea.min_lat, initialArea.min_lng], [initialArea.max_lat, initialArea.max_lng]] as L.LatLngBoundsExpression }
                : { center: EUROPE_CENTER, zoom: DEFAULT_ZOOM })}
            className="h-full w-full rounded-xl shadow-sm"
            scrollWheelZoom={true}
            zoomSnap={0.5}
            zoomDelta={0.5}
            wheelPxPerZoomLevel={120}
        >
            <TileLayer
                attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            />
            {areaOverlay && (
                <>
                    {/* Spotlight: dim everything OUTSIDE the active area by
                        drawing a polygon that covers the whole world with a
                        hole shaped like the active bbox. Reads as "in scope vs
                        out of scope" without competing with markers. */}
                    <Polygon
                        positions={[
                            [
                                [-90, -360],
                                [-90, 360],
                                [90, 360],
                                [90, -360],
                            ],
                            [
                                [areaOverlay.min_lat, areaOverlay.min_lng],
                                [areaOverlay.min_lat, areaOverlay.max_lng],
                                [areaOverlay.max_lat, areaOverlay.max_lng],
                                [areaOverlay.max_lat, areaOverlay.min_lng],
                            ],
                        ]}
                        pathOptions={{
                            stroke: false,
                            fillColor: '#0f172a',
                            fillOpacity: 0.18,
                            // Don't intercept clicks on markers in the dim area.
                            interactive: false,
                        }}
                    />
                    {/* Thin border on the active area for crispness. */}
                    <Rectangle
                        bounds={[
                            [areaOverlay.min_lat, areaOverlay.min_lng],
                            [areaOverlay.max_lat, areaOverlay.max_lng],
                        ]}
                        pathOptions={{
                            color: '#3b82f6',
                            weight: 1.5,
                            opacity: 0.7,
                            fill: false,
                            interactive: false,
                        }}
                    />
                </>
            )}
            <MapController
                positions={positions}
                focusedEventId={focusedEventId}
                focusedPosition={focusedPosition}
                markerRefs={markerRefs}
                autoFitToken={autoFitToken}
                flyToAreaToken={flyToAreaToken}
                skipInitialFit={!!initialArea}
            />
            <FlyToAreaController flyToArea={flyToArea} flyToAreaToken={flyToAreaToken} />
            <BoundsReporter onBoundsChange={onBoundsChange} />
            {geoEvents.map((e) => {
                const showFollowingOverlay = followingBadgeEnabled && showFollowingBadgeOverlay;
                const followingCount = showFollowingOverlay ? (e.following_friend_count ?? 0) : 0;
                const unseen = unseenStateEnabled && !!seenEventIds && !seenEventIds.has(e.event_id);
                const score = e.popularity_score ?? 0;
                const trending = trendingEnabled
                    && score >= popularityThreshold
                    && topScores.includes(score);
                const totalGoing = e.going_count ?? 0;
                const dec: PinDecorations = { trending, followingCount, unseen, totalGoing };
                const isHovered = hoveredEventId === e.event_id;
                return (
                    <Marker
                        key={e.event_id}
                        ref={(marker) => registerMarker(e.event_id, marker)}
                        position={[e.latitude!, e.longitude!]}
                        icon={isHovered ? makeHighlightedIcon(eventColorBarColor, dec) : makeColoredIcon(eventColorBarColor, dec)}
                        eventHandlers={{
                            mouseover: () => onEventHover?.(e.event_id),
                            mouseout: () => onEventHover?.(null),
                            click: () => onMarkSeen?.(e.event_id),
                        }}
                    >
                        <Popup>
                            <div className="space-y-1.5 text-xs min-w-[180px]">
                                <p
                                    className="font-semibold text-sm cursor-pointer hover:text-slate-600"
                                    onClick={() => { onMarkSeen?.(e.event_id); onEventClick?.(e); }}
                                >
                                    {e.title}
                                </p>
                                <p className="text-slate-500">{formatDate(e)}</p>
                                {e.location && (
                                    <p className="text-slate-600">📍 {e.location}</p>
                                )}
                                {followingCount > 0 && (
                                    <AttendeeAvatarStack
                                        eventId={e.event_id}
                                        friendsPreview={showFollowingOverlay ? e.following_friends_preview : undefined}
                                    />
                                )}
                                {e.tags?.length > 0 && (
                                    <TagBadges tags={e.tags} maxVisible={3} />
                                )}
                                <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                                    <div className="flex items-center gap-1">
                                        <SaveEventButton eventId={e.event_id} appearance="icon" size="sm" stopPropagation />
                                        <GoingButton eventId={e.event_id} appearance="icon" size="sm" stopPropagation />
                                        {showRatings && <RateEventButton eventId={e.event_id} appearance="icon" size="sm" stopPropagation />}
                                    </div>
                                    <Link
                                        to={`/event/${e.event_id}${detailLinkSource ? `?src=${detailLinkSource}` : ''}`}
                                        className="text-[10px] font-medium text-rose-500 hover:text-rose-700"
                                    >
                                        Details →
                                    </Link>
                                </div>
                            </div>
                        </Popup>
                    </Marker>
                );
            })}
        </MapContainer>
    );
}
