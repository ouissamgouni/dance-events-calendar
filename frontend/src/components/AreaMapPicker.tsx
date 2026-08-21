import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleMarker, MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { PreferredAreaPayload } from '../api';
import { AREA_PRESETS, clampArea, DEFAULT_AREA_BBOX } from '../constants/area';

interface Props {
    /** Currently saved area (or null = no area saved). */
    value: PreferredAreaPayload | null;
    /** Fired when the user commits an area via the centered "Save area"
     * button (shown once the box is moved). */
    onChange: (area: PreferredAreaPayload) => void;
    /** Optional callback fired immediately after the user saves the current
     * view — lets the parent move focus (e.g. into a rename textbox) so the
     * next thing the user does is naming the area. */
    onUseCurrentView?: () => void;
    /** Optional control rendered below the map. */
    controlsStart?: ReactNode;
    /** Tailwind height class for the map container. Default 'h-72'. */
    mapHeightClass?: string;
    /** Optional event pins plotted on the map (e.g. a worldwide preview). */
    markers?: Array<{ id: string; lat: number; lng: number }>;
    /** Render the built-in preset pill row above the map. Default true. */
    showPresets?: boolean;
    /** Commit the box live on every pan/zoom instead of showing a centered
     * "Save area" button. Used by the filter sheet where the footer CTA
     * applies the result. */
    autoCommit?: boolean;
    /** Recenter the map on this point (e.g. a geocoded search result). The
     * guide box keeps its on-screen size, so the resulting bbox follows. */
    centerOverride?: { lat: number; lng: number; zoom?: number } | null;
}

const GUIDE_INSET_X_RATIO = 0.2;
const GUIDE_INSET_Y_RATIO = 0.22;

/**
 * Embedded Leaflet map used as a bounding-box picker in onboarding/settings.
 * The map moves underneath a fixed guide box; saving converts that on-screen
 * guide into geographic bounds so the interaction matches what users see.
 */
export default function AreaMapPicker({ value, onChange, onUseCurrentView, controlsStart, mapHeightClass = 'h-72', markers, showPresets = true, autoCommit = false, centerOverride }: Props) {
    const initial = value ?? DEFAULT_AREA_BBOX;
    const initialAreaRef = useRef(initial);
    const lastAppliedExternalRef = useRef<PreferredAreaPayload>(initial);
    const mapRef = useRef<L.Map | null>(null);
    const guideRef = useRef<HTMLDivElement | null>(null);
    // ``mapReady`` flips true once the underlying Leaflet map has mounted so
    // effects that need the map instance (dirty-tracking listeners) can
    // attach at the right time. Reading ``mapRef.current`` synchronously in
    // an effect races with ``MapRefBinder``, which is why we track readiness
    // explicitly.
    const [mapReady, setMapReady] = useState(false);
    // ``dirty`` becomes true once the user pans/zooms the box away from the
    // last committed position. It gates the centered "Save area" button.
    const [dirty, setDirty] = useState(false);
    // Baseline bbox (as computed from the on-screen guide) representing the
    // last committed position. Leaflet's ``fitBounds`` emits several
    // moveend/zoomend events as the layout settles, so we capture the first
    // settled bbox as the baseline and only mark dirty when a later bbox
    // materially differs. Held in a ref so the save/reset handlers can reset
    // it without re-binding the Leaflet listeners.
    const baselineRef = useRef<PreferredAreaPayload | null>(null);
    const valueLabelRef = useRef(value?.label ?? null);
    useEffect(() => { valueLabelRef.current = value?.label ?? null; }, [value?.label]);
    // Read autoCommit/onChange through refs so the Leaflet listener effect
    // doesn't re-bind (and reset its baseline) on every parent render.
    const autoCommitRef = useRef(autoCommit);
    useEffect(() => { autoCommitRef.current = autoCommit; }, [autoCommit]);
    const onChangeRef = useRef(onChange);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

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
        setMapReady(true);
    }, [fitAreaInGuide]);

    // Keep the uncontrolled map synced when an external value arrives late
    // (e.g. prefs hydration after refresh) or changes from outside. Avoid
    // clobbering in-progress user edits while dirty.
    useEffect(() => {
        if (!mapReady || dirty) return;
        const next = value ?? DEFAULT_AREA_BBOX;
        const prev = lastAppliedExternalRef.current;
        // Label-only changes (e.g. renaming the saved area) must NOT refit the
        // map — doing so makes the just-saved box visibly jump.
        const unchanged =
            Math.abs(next.min_lat - prev.min_lat) < 1e-6
            && Math.abs(next.min_lng - prev.min_lng) < 1e-6
            && Math.abs(next.max_lat - prev.max_lat) < 1e-6
            && Math.abs(next.max_lng - prev.max_lng) < 1e-6;
        if (unchanged) {
            lastAppliedExternalRef.current = next;
            return;
        }
        baselineRef.current = null;
        setDirty(false);
        fitAreaInGuide(next);
        lastAppliedExternalRef.current = next;
    }, [dirty, fitAreaInGuide, mapReady, value]);

    // Compute the area from the guide's current on-screen position.
    // Shared by the save handler and the dirty-tracking listener.
    const computeGuideArea = useCallback((): PreferredAreaPayload | null => {
        const map = mapRef.current;
        const guide = guideRef.current;
        if (!map || !guide) return null;
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
            label: valueLabelRef.current ?? 'Custom area',
        });
        if (area.min_lat >= area.max_lat || area.min_lng >= area.max_lng) return null;
        return area;
    }, []);

    const handleSave = () => {
        const area = computeGuideArea();
        if (!area) return;
        baselineRef.current = area;
        lastAppliedExternalRef.current = area;
        setDirty(false);
        onChange(area);
        onUseCurrentView?.();
    };

    // Attach moveend/zoomend listeners that flip ``dirty`` on once the box
    // has been moved away from the last committed baseline. Leaflet's initial
    // ``fitBounds`` (and subsequent programmatic fits) emit BOTH a moveend
    // and a zoomend as the layout settles, so a one-shot flag isn't enough —
    // the second init event slips through. Instead capture the settled bbox
    // as a baseline on the first callback and only mark dirty when a later
    // callback yields a bbox that materially differs from that baseline.
    // Depends on ``mapReady`` so the effect re-runs once the map instance is
    // actually available.
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        const nearlyEqual = (a: PreferredAreaPayload, b: PreferredAreaPayload) =>
            Math.abs(a.min_lat - b.min_lat) < 1e-3 &&
            Math.abs(a.max_lat - b.max_lat) < 1e-3 &&
            Math.abs(a.min_lng - b.min_lng) < 1e-3 &&
            Math.abs(a.max_lng - b.max_lng) < 1e-3;
        const handler = () => {
            const area = computeGuideArea();
            if (!area) return;
            if (baselineRef.current == null) {
                baselineRef.current = area;
                return;
            }
            if (nearlyEqual(area, baselineRef.current)) return;
            if (autoCommitRef.current) {
                // Live-apply mode: commit the new box straight away so the
                // sheet's event count tracks the pan/zoom.
                baselineRef.current = area;
                lastAppliedExternalRef.current = area;
                onChangeRef.current(area);
                return;
            }
            setDirty(true);
        };
        map.on('moveend', handler);
        map.on('zoomend', handler);
        return () => {
            map.off('moveend', handler);
            map.off('zoomend', handler);
        };
    }, [computeGuideArea, mapReady]);

    // Recenter on an external point (geocoded search result) while keeping the
    // guide box's on-screen size; the moveend that follows recomputes the bbox
    // (and auto-commits it when in live-apply mode).
    useEffect(() => {
        if (!mapReady || !centerOverride) return;
        const map = mapRef.current;
        if (!map) return;
        map.setView([centerOverride.lat, centerOverride.lng], centerOverride.zoom ?? 9, { animate: true });
    }, [centerOverride, mapReady]);

    // Preset pills reposition the box over a predefined region. We keep the
    // existing baseline so the resulting move registers as dirty and the
    // centered "Save area" button appears for the user to confirm.
    const handlePreset = (preset: (typeof AREA_PRESETS)[number]) => {
        fitAreaInGuide({ ...preset });
    };

    return (
        <div>
            {showPresets && (
                <div className="mb-2 flex flex-nowrap items-center gap-1 overflow-x-auto scrollbar-hide">
                    {AREA_PRESETS.map((preset) => (
                        <button
                            key={preset.label}
                            type="button"
                            onClick={() => handlePreset(preset)}
                            className="shrink-0 whitespace-nowrap border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink hover:bg-canvas"
                        >
                            {preset.label === 'Worldwide' ? '🌐' : preset.label}
                        </button>
                    ))}
                </div>
            )}
            <div className={`relative ${mapHeightClass} w-full max-w-md overflow-hidden border border-line`}>
                <MapContainer
                    bounds={initialBounds}
                    style={{ height: '100%', width: '100%' }}
                    scrollWheelZoom
                    worldCopyJump
                    zoomSnap={0.1}
                    zoomDelta={0.25}
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
                    {markers?.map((m) => (
                        <CircleMarker
                            key={m.id}
                            center={[m.lat, m.lng]}
                            radius={4}
                            pathOptions={{ color: '#2563eb', weight: 1, fillColor: '#2563eb', fillOpacity: 0.8 }}
                        />
                    ))}
                </MapContainer>
                <div
                    ref={guideRef}
                    className="pointer-events-none absolute inset-x-[20%] inset-y-[22%] border-2 border-dashed border-action bg-action/10 shadow-[0_0_0_9999px_rgba(15,23,42,0.12)]"
                    aria-hidden="true"
                >
                    {/* Round corner handles to echo a draggable selection. */}
                    {/* eslint-disable no-restricted-syntax -- circular selection handles per the design reference */}
                    <span className="absolute -left-[6px] -top-[6px] h-3 w-3 rounded-full border-2 border-action bg-white" />
                    <span className="absolute -right-[6px] -top-[6px] h-3 w-3 rounded-full border-2 border-action bg-white" />
                    <span className="absolute -bottom-[6px] -left-[6px] h-3 w-3 rounded-full border-2 border-action bg-white" />
                    <span className="absolute -bottom-[6px] -right-[6px] h-3 w-3 rounded-full border-2 border-action bg-white" />
                    {/* eslint-enable no-restricted-syntax */}
                    {!autoCommit && (
                        <div className="absolute left-2 top-2 bg-surface/90 px-2 py-1 text-[11px] font-medium text-action">
                            Area to save
                        </div>
                    )}
                </div>
                {dirty && !autoCommit && (
                    <div className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center">
                        <button
                            type="button"
                            onClick={handleSave}
                            className="pointer-events-auto bg-action px-3 py-2 text-xs font-semibold text-white shadow-lg hover:bg-action"
                            data-testid="area-save-current"
                        >
                            Save area
                        </button>
                    </div>
                )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
                {controlsStart}
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
