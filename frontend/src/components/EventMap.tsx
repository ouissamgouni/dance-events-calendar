import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { MapContainer, Polygon, Rectangle, TileLayer, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet.markercluster';
import type { CalendarEvent } from '../types';
import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';
import RateEventButton from './RateEventButton';
import TagBadges from './TagBadges';
import AttendeeAvatarStack, { PEOPLE_ICON_PATH } from './AttendeeAvatarStack';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { DEFAULT_AREA_BBOX } from '../constants/area';

export interface MapBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

const DEFAULT_AREA_CENTER: [number, number] = [
    (DEFAULT_AREA_BBOX.min_lat + DEFAULT_AREA_BBOX.max_lat) / 2,
    (DEFAULT_AREA_BBOX.min_lng + DEFAULT_AREA_BBOX.max_lng) / 2,
];
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
    /** True when popularity_score is in the current top slice; draws the trending badge. */
    trending?: boolean;
    /** Count of followed people going; draws a blue chip at bottom-right. */
    followingCount?: number;
    /** True when the event was added after the viewer's local baseline; draws a blue dot at top-right. */
    newEvent?: boolean;
    /** Total going count for the event; rendered as a small slate chip at
     * top-left so the pin conveys "how many attendees" even when there are
     * no mutual friends. */
    totalGoing?: number;
}

function imageChipIcon(src: string, alt: string): string {
    return `<img src="${src}" alt="${alt}" width="8" height="8" style="display:block;width:8px;height:8px;object-fit:contain;margin-right:2px;" />`;
}

/** Inline SVG version of the two-head `PeopleIcon` glyph (shared path
 * from AttendeeAvatarStack.tsx) for use inside Leaflet's raw HTML
 * marker icons, which can't mount a React component directly. */
function peopleSvgChipIcon(color: string): string {
    return `<svg aria-hidden="true" viewBox="0 0 20 20" width="8" height="8" fill="${color}" style="display:block;width:8px;height:8px;margin-right:2px;"><path d="${PEOPLE_ICON_PATH}" /></svg>`;
}

function trendingBadge(size: number): string {
    const badgeSize = size >= 36 ? 16 : 14;
    return `<span style="position:absolute;right:-5px;top:-6px;display:inline-flex;align-items:center;justify-content:center;width:${badgeSize}px;height:${badgeSize}px;background:transparent;border:0;box-sizing:content-box;"><img src="/trending.png" alt="Trending" width="${badgeSize}" height="${badgeSize}" style="display:block;width:${badgeSize}px;height:${badgeSize}px;object-fit:contain;" /></span>`;
}

/** Build the HTML for the following-friend chip (bottom-right). */
function followingChip(count: number): string {
    const label = count >= 10 ? '9+' : String(count);
    const icon = peopleSvgChipIcon('#3b82f6');
    return `<span style="position:absolute;right:-6px;bottom:-6px;display:inline-flex;align-items:center;min-width:18px;height:14px;padding:0 4px;background:white;color:black;font-size:9px;font-weight:700;line-height:14px;border:1.5px solid rgba(255,255,255,0.8);box-sizing:content-box;font-family:system-ui,sans-serif;">${icon}${label}</span>`;
}

/** Build the HTML for the new-event dot (top-right). Blue dot matches the
 * new-event affordance on the cards (`bg-blue-500`). */
function newEventDot(): string {
    return `<span style="position:absolute;right:-2px;top:-2px;width:8px;height:8px;border-radius:9999px;background:#3b82f6;border:1.5px solid white;box-sizing:content-box;"></span>`;
}

/** Build the HTML for the total-going chip (top-left). Slate (neutral)
 * so it reads as "how many" without competing with the friends-going
 * (blue) or new-event (blue) social signals. */
function totalGoingChip(count: number): string {
    const label = count >= 100 ? '99+' : String(count);
    const icon = imageChipIcon('/user.png', 'Going');
    return `<span style="position:absolute;left:-6px;top:-6px;display:inline-flex;align-items:center;justify-content:center;min-width:14px;height:14px;padding:0 3px;background:#475569;color:white;font-size:9px;font-weight:700;line-height:14px;border:1.5px solid white;box-sizing:content-box;font-family:system-ui,sans-serif;">${icon}${label}</span>`;
}

function makeColoredIcon(color: string | null, dec?: PinDecorations): L.DivIcon {
    const fill = color || '#3b82f6';
    const trendBadge = dec?.trending ? trendingBadge(28) : '';
    const followBadge = dec?.followingCount && dec.followingCount > 0 ? followingChip(dec.followingCount) : '';
    const newBadge = dec?.newEvent ? newEventDot() : '';
    const totalBadge = dec?.totalGoing && dec.totalGoing > 0 ? totalGoingChip(dec.totalGoing) : '';
    return L.divIcon({
        className: '',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14],
        html: `<div style="position:relative;width:28px;height:28px;"><svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="14" r="11" fill="${fill}" stroke="white" stroke-width="2.5" />
            <circle cx="14" cy="14" r="4" fill="white" opacity="0.9" />
        </svg>${totalBadge}${newBadge}${trendBadge}${followBadge}</div>`,
    });
}

function makeHighlightedIcon(color: string | null, dec?: PinDecorations): L.DivIcon {
    const fill = color || '#3b82f6';
    const trendBadge = dec?.trending ? trendingBadge(36) : '';
    const followBadge = dec?.followingCount && dec.followingCount > 0 ? followingChip(dec.followingCount) : '';
    const newBadge = dec?.newEvent ? newEventDot() : '';
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
        </svg>${totalBadge}${newBadge}${trendBadge}${followBadge}</div>`,
    });
}

function makeClusterIcon(cluster: L.MarkerCluster): L.DivIcon {
    const count = cluster.getChildCount();
    const size = count >= 50 ? 46 : count >= 10 ? 40 : 34;
    return L.divIcon({
        className: '',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:#3b82f6;color:white;border:3px solid white;box-shadow:0 2px 10px rgba(15,23,42,0.22);font:800 13px/1 system-ui,sans-serif;box-sizing:border-box;">${count}</div>`,
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
     * "Default area" snap-back action so the map view returns to the user's
     * configured default area while the parent keeps filtering events by the
     * active area, not by the live viewport. */
    flyToArea?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
    flyToAreaToken?: number;
    /** Optional initial bbox to open the map at, captured ONCE on mount.
     * Avoids the two-step zoom of (a) first marker auto-fit, then (b)
     * imperative flyToArea re-fit. When provided, the marker auto-fit is
     * also suppressed for the first render. */
    initialArea?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
    /** Keep the current viewport even if the visible marker set changes. */
    preserveViewport?: boolean;
    /** Set of event_ids added after the viewer's local baseline. Drives the
     * dot overlay when ``unseenStateEnabled`` is on. */
    newEventIds?: Set<string>;
    /** Threshold for the trending pin ring. Defaults to 10 to match the
     * list panel's ``PopularityBadge``. */
    popularityThreshold?: number;
    /** Called when a pin (or its popup title) is clicked; the parent uses
     * this to mark the event as seen. */
    onMarkSeen?: (eventId: string) => void;
    /** Disable Leaflet popups for compact surfaces that render their own
     * selected-event UI outside the map. */
    disablePopups?: boolean;
    /** Called when a marker itself is selected. Separate from popup title
     * clicks, which continue through ``onEventClick``. */
    onMarkerSelect?: (event: CalendarEvent) => void;
    /** Per-render override for the following-badge overlay on map pins.
     * When the site-wide ``followingBadgeEnabled`` flag is on, this lets
     * the user temporarily hide the friends-going chip on the map without
     * disabling the badge elsewhere (cards, modal). Defaults to ``true``.
     * Has no effect when the site-wide flag is off. */
    showFollowingBadgeOverlay?: boolean;
    /** Per-render override for the trending overlay on map pins. Defaults to true and
     * has no effect when the site-wide ``trendingEnabled`` flag is off. */
    showTrendingOverlay?: boolean;
}

interface PopupPortal {
    key: string;
    host: HTMLDivElement;
    event: CalendarEvent;
    followingCount: number;
    showFollowingOverlay: boolean;
}

function EventPopupContent({ event, followingCount, showFollowingOverlay, showRatings, detailLinkSource, formatDate, onEventClick, onMarkSeen }: {
    event: CalendarEvent;
    followingCount: number;
    showFollowingOverlay: boolean;
    showRatings: boolean;
    detailLinkSource?: string;
    formatDate: (event: CalendarEvent) => string;
    onEventClick?: (event: CalendarEvent) => void;
    onMarkSeen?: (eventId: string) => void;
}) {
    return (
        <div className="space-y-1.5 text-xs min-w-[180px]">
            <p
                className="font-semibold text-sm cursor-pointer hover:text-slate-600"
                onClick={() => { onMarkSeen?.(event.event_id); onEventClick?.(event); }}
            >
                {event.title}
            </p>
            <p className="text-slate-500">{formatDate(event)}</p>
            {event.location && (
                <p className="text-slate-600">📍 {event.location}</p>
            )}
            {followingCount > 0 && (
                <AttendeeAvatarStack
                    eventId={event.event_id}
                    friendsPreview={showFollowingOverlay ? event.following_friends_preview : undefined}
                />
            )}
            {event.tags?.length > 0 && (
                <TagBadges tags={event.tags} maxVisible={3} />
            )}
            <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                <div className="flex items-center gap-1">
                    <SaveEventButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation />
                    <GoingButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation />
                    {showRatings && <RateEventButton eventId={event.event_id} appearance="icon" size="sm" stopPropagation />}
                </div>
                <Link
                    to={`/event/${event.event_id}${detailLinkSource ? `?src=${detailLinkSource}` : ''}`}
                    className="text-[10px] font-medium text-blue-500 hover:text-blue-600"
                >
                    Details →
                </Link>
            </div>
        </div>
    );
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

function MapResizeController() {
    const map = useMap();

    useEffect(() => {
        const container = map.getContainer();
        let frame: number | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const invalidate = () => {
            if (frame !== null) cancelAnimationFrame(frame);
            if (timer !== null) clearTimeout(timer);

            frame = requestAnimationFrame(() => {
                map.invalidateSize({ pan: false, debounceMoveend: true });
                frame = null;
            });
            timer = setTimeout(() => {
                map.invalidateSize({ pan: false, debounceMoveend: true });
                timer = null;
            }, 250);
        };

        const observer = new ResizeObserver(invalidate);
        observer.observe(container);
        window.addEventListener('orientationchange', invalidate);
        invalidate();

        return () => {
            observer.disconnect();
            window.removeEventListener('orientationchange', invalidate);
            if (frame !== null) cancelAnimationFrame(frame);
            if (timer !== null) clearTimeout(timer);
        };
    }, [map]);

    return null;
}

function MapController({
    positions,
    focusedEventId,
    focusedPosition,
    markerRefs,
    clusterGroupRef,
    autoFitToken,
    flyToAreaToken,
    skipInitialFit,
    preserveViewport,
}: {
    positions: [number, number][];
    focusedEventId: string | null;
    focusedPosition: [number, number] | null;
    markerRefs: MutableRefObject<Map<string, L.Marker>>;
    clusterGroupRef: MutableRefObject<L.MarkerClusterGroup | null>;
    autoFitToken: number | undefined;
    flyToAreaToken: number | undefined;
    /** When true, suppress the very first marker auto-fit (the parent has
     * already opened the map at a known bbox via ``initialArea``). */
    skipInitialFit: boolean;
    preserveViewport: boolean;
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
                const clusterGroup = clusterGroupRef.current;
                if (marker && clusterGroup) {
                    clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
                    return;
                }
                if (marker) marker.openPopup();
            };
            map.once('moveend', openPopup);
            map.flyTo(focusedPosition, CITY_ZOOM, { duration: 0.8 });
            return;
        }

        if (prevFocused.current !== null) {
            prevFocused.current = null;
            if (positions.length === 0) {
                map.flyTo(DEFAULT_AREA_CENTER, DEFAULT_ZOOM, { duration: 0.8 });
            } else if (positions.length === 1) {
                map.flyTo(positions[0], CITY_ZOOM, { duration: 0.8 });
            } else {
                map.invalidateSize();
                map.flyToBounds(L.latLngBounds(positions), { padding: adaptiveMarkerPadding(map), duration: 0.8 });
            }
        }
    }, [clusterGroupRef, focusedEventId, focusedPosition, map, markerRefs, positions]);

    // Snapshot of the positions key captured at the moment of a token
    // bump. While set, the next *change* in positions is treated as the
    // result of an async refetch triggered by the same user action and
    // gets a follow-up fit. Cleared after that follow-up fit so later
    // unrelated position updates don't override the user's viewport.
    const positionsSnapshotAtBump = useRef<string | null>(null);

    // When the parent issues an imperative flyToArea (Default / Europe /
    // World pills) we want a TWO-STEP behaviour:
    //   1. ``FlyToAreaController`` snaps the map to the requested bbox now
    //      (the parent controls which events are in the active area).
    //   2. We then tighten the view to the actual marker bounds — either
    //      after positions change, or right away if positions already match
    //      (e.g. clicking the same preset twice). Much more useful than
    //      staying framed on a continent-sized bbox when events cluster in a
    //      few cities.
    const lastFlyToken = useRef<number | undefined>(flyToAreaToken);
    useEffect(() => {
        if (flyToAreaToken === undefined) return;
        if (lastFlyToken.current === flyToAreaToken) return;
        lastFlyToken.current = flyToAreaToken;
        if (preserveViewport) {
            positionsSnapshotAtBump.current = null;
            return;
        }
        const positionsKey = positions
            .map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`)
            .join('|');
        positionsSnapshotAtBump.current = positionsKey;
        // Schedule a follow-up fit-to-markers a bit after the area fit, so
        // even when positions do not change we still tighten around the
        // existing markers. Skipped when the positions snapshot mechanism
        // below has already fired.
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
    }, [flyToAreaToken, map, positions, preserveViewport]);

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
        if (preserveViewport) return;

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
        // DEFAULT_AREA_CENTER + DEFAULT_ZOOM here would overwrite the viewport
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
    }, [autoFitToken, focusedPosition, map, positions, preserveViewport]);

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

function MarkerClusterLayer({
    events,
    hoveredEventId,
    eventColorBarColor,
    followingBadgeEnabled,
    showFollowingBadgeOverlay,
    unseenStateEnabled,
    newEventIds,
    trendingEnabled,
    showTrendingOverlay,
    popularityThreshold,
    topScores,
    showRatings,
    markerRefs,
    clusterGroupRef,
    detailLinkSource,
    formatDate,
    onEventClick,
    onEventHover,
    onMarkerSelect,
    onMarkSeen,
    disablePopups,
}: {
    events: CalendarEvent[];
    hoveredEventId?: string | null;
    eventColorBarColor: string | null;
    followingBadgeEnabled: boolean;
    showFollowingBadgeOverlay: boolean;
    unseenStateEnabled: boolean;
    newEventIds?: Set<string>;
    trendingEnabled: boolean;
    showTrendingOverlay: boolean;
    popularityThreshold: number;
    topScores: number[];
    showRatings: boolean;
    markerRefs: MutableRefObject<Map<string, L.Marker>>;
    clusterGroupRef: MutableRefObject<L.MarkerClusterGroup | null>;
    detailLinkSource?: string;
    formatDate: (event: CalendarEvent) => string;
    onEventClick?: (event: CalendarEvent) => void;
    onEventHover?: (eventId: string | null) => void;
    onMarkerSelect?: (event: CalendarEvent) => void;
    onMarkSeen?: (eventId: string) => void;
    disablePopups?: boolean;
}) {
    const map = useMap();
    const [popupPortals, setPopupPortals] = useState<PopupPortal[]>([]);

    useEffect(() => {
        const clusterGroup = L.markerClusterGroup({
            chunkedLoading: true,
            disableClusteringAtZoom: 16,
            iconCreateFunction: makeClusterIcon,
            maxClusterRadius: 30,
            showCoverageOnHover: false,
            spiderfyOnMaxZoom: true,
            zoomToBoundsOnClick: true,
        });
        clusterGroupRef.current = clusterGroup;
        map.addLayer(clusterGroup);

        return () => {
            map.removeLayer(clusterGroup);
            clusterGroupRef.current = null;
        };
    }, [clusterGroupRef, map]);

    useEffect(() => {
        const clusterGroup = clusterGroupRef.current;
        if (!clusterGroup) return;

        clusterGroup.clearLayers();
        markerRefs.current.clear();

        const nextPortals: PopupPortal[] = [];

        events.forEach((event) => {
            const showFollowingOverlay = followingBadgeEnabled && showFollowingBadgeOverlay;
            const followingCount = showFollowingOverlay ? (event.following_friend_count ?? 0) : 0;
            const newEvent = unseenStateEnabled && !!newEventIds?.has(event.event_id);
            const score = event.popularity_score ?? 0;
            const trending = trendingEnabled
                && showTrendingOverlay
                && score >= popularityThreshold
                && topScores.includes(score);
            const totalGoing = event.going_count ?? 0;
            const decorations: PinDecorations = { trending, followingCount, newEvent, totalGoing };
            const isHovered = hoveredEventId === event.event_id;
            const marker = L.marker([event.latitude!, event.longitude!], {
                icon: isHovered ? makeHighlightedIcon(eventColorBarColor, decorations) : makeColoredIcon(eventColorBarColor, decorations),
            });
            let popupHost: HTMLDivElement | null = null;
            if (!disablePopups) {
                popupHost = document.createElement('div');
                marker.bindPopup(popupHost);
            }
            marker.on('mouseover', () => onEventHover?.(event.event_id));
            marker.on('mouseout', () => onEventHover?.(null));
            marker.on('click', () => {
                onMarkSeen?.(event.event_id);
                onMarkerSelect?.(event);
            });

            markerRefs.current.set(event.event_id, marker);
            clusterGroup.addLayer(marker);
            if (popupHost) {
                nextPortals.push({
                    key: event.event_id,
                    host: popupHost,
                    event,
                    followingCount,
                    showFollowingOverlay,
                });
            }
        });

        setPopupPortals(nextPortals);

        return () => {
            clusterGroup.clearLayers();
            markerRefs.current.clear();
            setPopupPortals([]);
        };
    }, [clusterGroupRef, detailLinkSource, disablePopups, eventColorBarColor, events, followingBadgeEnabled, formatDate, hoveredEventId, markerRefs, newEventIds, onEventClick, onEventHover, onMarkerSelect, onMarkSeen, popularityThreshold, showFollowingBadgeOverlay, showRatings, showTrendingOverlay, topScores, trendingEnabled, unseenStateEnabled]);

    return (
        <>
            {popupPortals.map((portal) => createPortal(
                <EventPopupContent
                    event={portal.event}
                    followingCount={portal.followingCount}
                    showFollowingOverlay={portal.showFollowingOverlay}
                    showRatings={showRatings}
                    detailLinkSource={detailLinkSource}
                    formatDate={formatDate}
                    onEventClick={onEventClick}
                    onMarkSeen={onMarkSeen}
                />,
                portal.host,
                portal.key,
            ))}
        </>
    );
}

export default function EventMap({ events, focusedEvent, onEventClick, onBoundsChange, hoveredEventId, onEventHover, detailLinkSource, areaOverlay, autoFitToken, flyToArea, flyToAreaToken, initialArea, preserveViewport, newEventIds, popularityThreshold = 10, onMarkSeen, disablePopups = false, onMarkerSelect, showFollowingBadgeOverlay = true, showTrendingOverlay = true }: Props) {
    const { showRatings, eventColorBarColor, followingBadgeEnabled, unseenStateEnabled, trendingEnabled, trendingTopN, trendingTopPercent } = useFeatureFlags();
    const markerRefs = useRef(new Map<string, L.Marker>());
    const clusterGroupRef = useRef<L.MarkerClusterGroup | null>(null);
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

    const formatDate = useCallback((e: CalendarEvent) => {
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
    }, []);

    return (
        <MapContainer
            {...(initialArea
                ? { bounds: [[initialArea.min_lat, initialArea.min_lng], [initialArea.max_lat, initialArea.max_lng]] as L.LatLngBoundsExpression }
                : { center: DEFAULT_AREA_CENTER, zoom: DEFAULT_ZOOM })}
            className="h-full w-full shadow-sm"
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
                clusterGroupRef={clusterGroupRef}
                autoFitToken={autoFitToken}
                flyToAreaToken={flyToAreaToken}
                skipInitialFit={!!initialArea}
                preserveViewport={preserveViewport ?? false}
            />
            <MapResizeController />
            <FlyToAreaController flyToArea={flyToArea} flyToAreaToken={flyToAreaToken} />
            <BoundsReporter onBoundsChange={onBoundsChange} />
            <MarkerClusterLayer
                events={geoEvents}
                hoveredEventId={hoveredEventId}
                eventColorBarColor={eventColorBarColor}
                followingBadgeEnabled={followingBadgeEnabled}
                showFollowingBadgeOverlay={showFollowingBadgeOverlay}
                unseenStateEnabled={unseenStateEnabled}
                newEventIds={newEventIds}
                trendingEnabled={trendingEnabled}
                showTrendingOverlay={showTrendingOverlay}
                popularityThreshold={popularityThreshold}
                topScores={topScores}
                showRatings={showRatings}
                markerRefs={markerRefs}
                clusterGroupRef={clusterGroupRef}
                detailLinkSource={detailLinkSource}
                formatDate={formatDate}
                onEventClick={onEventClick}
                onEventHover={onEventHover}
                onMarkerSelect={onMarkerSelect}
                onMarkSeen={onMarkSeen}
                disablePopups={disablePopups}
            />
        </MapContainer>
    );
}
