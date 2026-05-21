import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { PreferredAreaPayload } from '../api';
import { clampArea, DEFAULT_AREA_BBOX } from '../constants/area';

interface Props {
    /** Currently saved area (or null = no area saved). */
    value: PreferredAreaPayload | null;
    /** Fired when the user picks "Save area in box" or "Reset to default". */
    onChange: (area: PreferredAreaPayload) => void;
    /** Optional callback fired immediately after the user clicks
     * "Save area in box" — lets the parent move focus (e.g. into a
     * rename textbox) so the next thing the user does is naming the area. */
    onUseCurrentView?: () => void;
    /** Optional control rendered before the save/reset buttons. */
    controlsStart?: ReactNode;
}

const GUIDE_INSET_X_RATIO = 0.14;
const GUIDE_INSET_Y_RATIO = 0.16;

/**
 * Embedded Leaflet map used as a bounding-box picker in onboarding/settings.
 * The map moves underneath a fixed guide box; saving converts that on-screen
 * guide into geographic bounds so the interaction matches what users see.
 */
export default function AreaMapPicker({ value, onChange, onUseCurrentView, controlsStart }: Props) {
    const initial = value ?? DEFAULT_AREA_BBOX;
    const initialAreaRef = useRef(initial);
    const mapRef = useRef<L.Map | null>(null);
    const guideRef = useRef<HTMLDivElement | null>(null);

    const initialBounds = useMemo<L.LatLngBoundsExpression>(
        () => [
            [initialAreaRef.current.min_lat, initialAreaRef.current.min_lng],
            [initialAreaRef.current.max_lat, initialAreaRef.current.max_lng],
        ],
        // initialBounds is intentionally captured once: the map is uncontrolled
        // after mount; subsequent saves only change persisted preferences.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    const fitAreaInGuide = useCallback((area: PreferredAreaPayload) => {
        const map = mapRef.current;
        if (!map) return;
        const size = map.getSize();
        const paddingTopLeft = L.point(
            Math.round(size.x * GUIDE_INSET_X_RATIO),
            Math.round(size.y * GUIDE_INSET_Y_RATIO),
        );
        const paddingBottomRight = L.point(
            Math.round(size.x * GUIDE_INSET_X_RATIO),
            Math.round(size.y * GUIDE_INSET_Y_RATIO),
        );
        map.fitBounds(
            [
                [area.min_lat, area.min_lng],
                [area.max_lat, area.max_lng],
            ],
            { paddingTopLeft, paddingBottomRight },
        );
    }, []);

    const handleMapReady = useCallback(() => {
        fitAreaInGuide(initialAreaRef.current);
    }, [fitAreaInGuide]);

    const handleUseCurrentView = () => {
        const map = mapRef.current;
        const guide = guideRef.current;
        if (!map || !guide) return;
        const mapRect = map.getContainer().getBoundingClientRect();
        const guideRect = guide.getBoundingClientRect();
        const southWest = map.containerPointToLatLng(L.point(
            guideRect.left - mapRect.left,
            guideRect.bottom - mapRect.top,
        ));
        const northEast = map.containerPointToLatLng(L.point(
            guideRect.right - mapRect.left,
            guideRect.top - mapRect.top,
        ));
        const area = clampArea({
            min_lat: southWest.lat,
            min_lng: southWest.lng,
            max_lat: northEast.lat,
            max_lng: northEast.lng,
            label: value?.label ?? 'Custom area',
        });
        if (area.min_lat >= area.max_lat || area.min_lng >= area.max_lng) return;
        onChange(area);
        onUseCurrentView?.();
    };

    const handleResetDefault = () => {
        onChange(DEFAULT_AREA_BBOX);
        fitAreaInGuide(DEFAULT_AREA_BBOX);
    };

    return (
        <div>
            <p className="mb-2 max-w-md text-xs text-slate-600">
                Move and zoom the map until your preferred event area fits inside the box.
            </p>
            <div className="relative h-72 w-full max-w-md overflow-hidden border border-slate-300">
                <MapContainer
                    bounds={initialBounds}
                    style={{ height: '100%', width: '100%' }}
                    scrollWheelZoom
                    worldCopyJump
                    zoomSnap={0.5}
                    zoomDelta={0.5}
                    wheelPxPerZoomLevel={120}
                >
                    <MapRefBinder
                        mapRef={mapRef}
                        onReady={handleMapReady}
                    />
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                </MapContainer>
                <div
                    ref={guideRef}
                    className="pointer-events-none absolute inset-x-[14%] inset-y-[16%] border-2 border-blue-500 bg-blue-500/10 shadow-[0_0_0_9999px_rgba(15,23,42,0.12)]"
                    aria-hidden="true"
                >
                    <div className="absolute left-2 top-2 bg-white/90 px-2 py-1 text-[11px] font-medium text-blue-700">
                        Area to save
                    </div>
                </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
                {controlsStart}
                <button
                    type="button"
                    onClick={handleUseCurrentView}
                    className="bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
                >
                    Save area in box
                </button>
                <button
                    type="button"
                    onClick={handleResetDefault}
                    className="border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                    Reset to Europe & nearby
                </button>
            </div>
        </div>
    );
}

/**
 * Tiny child that captures the underlying ``L.Map`` instance into a parent ref
 * via ``useMap``. Cleaner than ``MapContainer.whenCreated`` (deprecated in
 * react-leaflet v4+) and avoids a second useEffect on the parent.
 */
function MapRefBinder({
    mapRef,
    onReady,
}: {
    mapRef: React.MutableRefObject<L.Map | null>;
    onReady: () => void;
}) {
    const map = useMap();
    useEffect(() => {
        mapRef.current = map;
        const frame = window.requestAnimationFrame(onReady);
        return () => {
            window.cancelAnimationFrame(frame);
            mapRef.current = null;
        };
    }, [map, mapRef, onReady]);
    return null;
}
