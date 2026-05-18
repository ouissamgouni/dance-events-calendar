import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, Rectangle, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { PreferredAreaPayload } from '../api';
import { DEFAULT_AREA_BBOX } from '../constants/area';

interface Props {
    /** Currently saved area (or null = no area saved). */
    value: PreferredAreaPayload | null;
    /** Fired when the user picks "Use current map view" or "Reset to default". */
    onChange: (area: PreferredAreaPayload) => void;
    /** Optional callback fired immediately after the user clicks
     * "Use current map view" — lets the parent move focus (e.g. into a
     * rename textbox) so the next thing the user does is naming the area. */
    onUseCurrentView?: () => void;
}

/**
 * Embedded Leaflet map used as a bounding-box picker on the Settings page.
 * Keeps a ref to the underlying ``L.Map`` so the "Use current map view"
 * button can read the current viewport bounds without prop-drilling. The
 * saved bbox is rendered as a translucent rectangle for visual feedback.
 */
export default function AreaMapPicker({ value, onChange, onUseCurrentView }: Props) {
    const initial = value ?? DEFAULT_AREA_BBOX;
    const mapRef = useRef<L.Map | null>(null);

    const initialBounds = useMemo<L.LatLngBoundsExpression>(
        () => [
            [initial.min_lat, initial.min_lng],
            [initial.max_lat, initial.max_lng],
        ],
        // initialBounds is intentionally captured once: the map is uncontrolled
        // after mount; subsequent ``value`` updates only redraw the rectangle.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    const handleUseCurrentView = () => {
        const map = mapRef.current;
        if (!map) return;
        const b = map.getBounds();
        // Clamp to valid lat/lng so a wildly zoomed-out viewport doesn't
        // produce values like lng=-540 that the backend would reject.
        const minLat = Math.max(-90, Math.min(90, b.getSouth()));
        const maxLat = Math.max(-90, Math.min(90, b.getNorth()));
        const minLng = Math.max(-180, Math.min(180, b.getWest()));
        const maxLng = Math.max(-180, Math.min(180, b.getEast()));
        if (minLat >= maxLat || minLng >= maxLng) return;
        onChange({
            min_lat: minLat,
            min_lng: minLng,
            max_lat: maxLat,
            max_lng: maxLng,
            label: 'Custom area',
        });
        onUseCurrentView?.();
    };

    const handleResetDefault = () => {
        onChange(DEFAULT_AREA_BBOX);
        // Re-fit the map to the default bbox so the rectangle is visible.
        const map = mapRef.current;
        if (map) {
            map.fitBounds([
                [DEFAULT_AREA_BBOX.min_lat, DEFAULT_AREA_BBOX.min_lng],
                [DEFAULT_AREA_BBOX.max_lat, DEFAULT_AREA_BBOX.max_lng],
            ]);
        }
    };

    return (
        <div>
            <div className="h-72 w-full max-w-md overflow-hidden border border-slate-300">
                <MapContainer
                    bounds={initialBounds}
                    style={{ height: '100%', width: '100%' }}
                    scrollWheelZoom
                    worldCopyJump
                    zoomSnap={0.5}
                    zoomDelta={0.5}
                    wheelPxPerZoomLevel={120}
                >
                    <MapRefBinder mapRef={mapRef} />
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    {(() => {
                        // When no area is saved, fall back to the default
                        // bbox so the highlight rectangle is always visible
                        // — same visual treatment the user gets after
                        // clicking "Reset to default". Avoids a confusing
                        // empty-map state on first load.
                        const display = value ?? DEFAULT_AREA_BBOX;
                        return (
                            <Rectangle
                                key={`${display.min_lat},${display.min_lng},${display.max_lat},${display.max_lng}`}
                                bounds={[
                                    [display.min_lat, display.min_lng],
                                    [display.max_lat, display.max_lng],
                                ]}
                                pathOptions={{
                                    color: '#3b82f6',
                                    weight: 2,
                                    fillOpacity: 0.1,
                                    fillColor: '#3b82f6',
                                }}
                            />
                        );
                    })()}
                </MapContainer>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={handleUseCurrentView}
                    className="border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                    Use current map view
                </button>
                <button
                    type="button"
                    onClick={handleResetDefault}
                    className="border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                    Reset to default
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
function MapRefBinder({ mapRef }: { mapRef: React.MutableRefObject<L.Map | null> }) {
    const map = useMap();
    useEffect(() => {
        mapRef.current = map;
        return () => {
            mapRef.current = null;
        };
    }, [map, mapRef]);
    return null;
}
