import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import type { PreferredAreaPayload } from '../../api';
import { clampArea } from '../../constants/area';
import { hasMeaningfulAreaChange, hasMinimumAreaCoverage } from './onboardingGeometry';

interface Props {
    area: PreferredAreaPayload;
    alertsEnabled: boolean;
    nameManuallyEdited?: boolean;
    onAreaChange: (area: PreferredAreaPayload) => void;
    onAlertsChange: (enabled: boolean) => void;
    onNameManuallyEdited?: () => void;
    onBack: () => void;
    onContinue: () => void;
    continueLabel?: string;
}

type Corner = 'north-west' | 'north-east' | 'south-west' | 'south-east';

interface FrameRect {
    left: number;
    top: number;
    size: number;
}

interface ResizeState {
    corner: Corner;
    pointerId: number;
    frame: FrameRect;
}

interface ValidMapView {
    center: L.LatLng;
    zoom: number;
}

const MINIMUM_SIDE_KM = 1000;
const MINIMUM_FRAME_PX = 72;
const HANDLE_CLASSES: Record<Corner, string> = {
    'north-west': '-left-[22px] -top-[22px]',
    'north-east': '-right-[22px] -top-[22px]',
    'south-west': '-bottom-[22px] -left-[22px]',
    'south-east': '-bottom-[22px] -right-[22px]',
};

export default function OnboardingAreaEditor({
    area,
    alertsEnabled,
    nameManuallyEdited = false,
    onAreaChange,
    onAlertsChange,
    onNameManuallyEdited,
    onBack,
    onContinue,
    continueLabel = 'Continue',
}: Props) {
    const mapRef = useRef<L.Map | null>(null);
    const mapHostRef = useRef<HTMLDivElement | null>(null);
    const nameInputRef = useRef<HTMLInputElement | null>(null);
    const resizeRef = useRef<ResizeState | null>(null);
    const frameRef = useRef<FrameRect | null>(null);
    const initialAreaRef = useRef(area);
    const baselineAreaRef = useRef<PreferredAreaPayload | null>(null);
    const validMapViewRef = useRef<ValidMapView | null>(null);
    const areaRef = useRef(area);
    const manualNameRef = useRef(nameManuallyEdited);
    const onAreaChangeRef = useRef(onAreaChange);
    const [mapReady, setMapReady] = useState(false);
    const [frame, setFrame] = useState<FrameRect | null>(null);

    useEffect(() => { areaRef.current = area; }, [area]);
    useEffect(() => { manualNameRef.current = nameManuallyEdited; }, [nameManuallyEdited]);
    useEffect(() => { onAreaChangeRef.current = onAreaChange; }, [onAreaChange]);

    const updateFrame = useCallback((nextFrame: FrameRect) => {
        frameRef.current = nextFrame;
        setFrame(nextFrame);
    }, []);

    const computeFrameArea = useCallback((nextFrame: FrameRect): PreferredAreaPayload | null => {
        const map = mapRef.current;
        if (!map) return null;
        const northWest = map.containerPointToLatLng(L.point(nextFrame.left, nextFrame.top));
        const southEast = map.containerPointToLatLng(L.point(nextFrame.left + nextFrame.size, nextFrame.top + nextFrame.size));
        const nextArea = clampArea({
            label: areaRef.current.label,
            min_lat: southEast.lat,
            min_lng: northWest.lng,
            max_lat: northWest.lat,
            max_lng: southEast.lng,
        });
        if (nextArea.min_lat >= nextArea.max_lat || nextArea.min_lng >= nextArea.max_lng) return null;
        return nextArea;
    }, []);

    const publishFrameArea = useCallback((nextFrame: FrameRect) => {
        const nextArea = computeFrameArea(nextFrame);
        if (!nextArea) return null;
        const map = mapRef.current;
        if (baselineAreaRef.current && !hasMinimumAreaCoverage(nextArea, MINIMUM_SIDE_KM)) {
            const validView = validMapViewRef.current;
            if (map && validView) map.setView(validView.center, validView.zoom, { animate: false });
            return null;
        }
        if (!baselineAreaRef.current) baselineAreaRef.current = nextArea;
        if (map) validMapViewRef.current = { center: map.getCenter(), zoom: map.getZoom() };
        const label = manualNameRef.current
            ? areaRef.current.label
            : hasMeaningfulAreaChange(baselineAreaRef.current, nextArea)
                ? 'Custom'
                : initialAreaRef.current.label;
        const labelledArea = { ...nextArea, label };
        areaRef.current = labelledArea;
        onAreaChangeRef.current(labelledArea);
        return labelledArea;
    }, [computeFrameArea]);

    const handleMapReady = useCallback(() => setMapReady(true), []);

    useEffect(() => {
        if (!mapReady) return;
        const host = mapHostRef.current;
        const map = mapRef.current;
        if (!host || !map) return;
        const measure = () => {
            map.invalidateSize({ animate: false });
            const width = host.clientWidth;
            const height = host.clientHeight;
            if (width === 0 || height === 0) return;
            const maximumSide = Math.max(MINIMUM_FRAME_PX, Math.min(width - 64, height - 56));
            const currentSize = frameRef.current?.size ?? Math.min(maximumSide, Math.round(width * 0.62));
            const size = Math.min(currentSize, maximumSide);
            updateFrame({ left: (width - size) / 2, top: (height - size) / 2, size });
        };
        measure();
        const resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(host);
        return () => resizeObserver.disconnect();
    }, [mapReady, updateFrame]);

    useEffect(() => {
        if (!mapReady || !frame) return;
        const map = mapRef.current;
        if (!map || baselineAreaRef.current) return;
        const size = map.getSize();
        const horizontalPadding = Math.max(24, (size.x - frame.size) / 2);
        const verticalPadding = Math.max(24, (size.y - frame.size) / 2);
        map.fitBounds(
            [[initialAreaRef.current.min_lat, initialAreaRef.current.min_lng], [initialAreaRef.current.max_lat, initialAreaRef.current.max_lng]],
            {
                paddingTopLeft: L.point(horizontalPadding, verticalPadding),
                paddingBottomRight: L.point(horizontalPadding, verticalPadding),
                animate: false,
            },
        );
        const animationFrame = window.requestAnimationFrame(() => publishFrameArea(frame));
        return () => window.cancelAnimationFrame(animationFrame);
    }, [frame, mapReady, publishFrameArea]);

    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        const publish = () => {
            const currentFrame = frameRef.current;
            if (currentFrame) publishFrameArea(currentFrame);
        };
        map.on('moveend zoomend resize', publish);
        return () => { map.off('moveend zoomend resize', publish); };
    }, [mapReady, publishFrameArea]);

    const beginResize = (corner: Corner, event: ReactPointerEvent<HTMLDivElement>) => {
        const currentFrame = frameRef.current;
        const map = mapRef.current;
        if (!currentFrame || !map) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        map.dragging.disable();
        map.touchZoom.disable();
        resizeRef.current = { corner, pointerId: event.pointerId, frame: currentFrame };
    };

    const resizeFrame = (event: ReactPointerEvent<HTMLDivElement>) => {
        const activeResize = resizeRef.current;
        const host = mapHostRef.current;
        if (!activeResize || activeResize.pointerId !== event.pointerId || !host) return;
        event.preventDefault();
        event.stopPropagation();
        const hostRect = host.getBoundingClientRect();
        const pointerX = event.clientX - hostRect.left;
        const pointerY = event.clientY - hostRect.top;
        const start = activeResize.frame;
        const east = start.left + start.size;
        const south = start.top + start.size;
        const anchorX = activeResize.corner.includes('west') ? east : start.left;
        const anchorY = activeResize.corner.includes('north') ? south : start.top;
        const maximumSide = Math.min(
            activeResize.corner.includes('west') ? anchorX : host.clientWidth - anchorX,
            activeResize.corner.includes('north') ? anchorY : host.clientHeight - anchorY,
        );
        const requestedSide = Math.max(Math.abs(pointerX - anchorX), Math.abs(pointerY - anchorY));
        const size = Math.max(MINIMUM_FRAME_PX, Math.min(maximumSide, requestedSide));
        const nextFrame = {
            left: activeResize.corner.includes('west') ? anchorX - size : anchorX,
            top: activeResize.corner.includes('north') ? anchorY - size : anchorY,
            size,
        };
        const nextArea = computeFrameArea(nextFrame);
        if (!nextArea || (size < start.size && !hasMinimumAreaCoverage(nextArea, MINIMUM_SIDE_KM))) return;
        updateFrame(nextFrame);
        publishFrameArea(nextFrame);
    };

    const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (resizeRef.current?.pointerId !== event.pointerId) return;
        resizeRef.current = null;
        mapRef.current?.dragging.enable();
        mapRef.current?.touchZoom.enable();
    };

    const focusName = () => {
        const currentFrame = frameRef.current;
        if (currentFrame) publishFrameArea(currentFrame);
        window.requestAnimationFrame(() => {
            nameInputRef.current?.focus();
            nameInputRef.current?.select();
        });
    };

    const updateName = (value: string) => {
        manualNameRef.current = true;
        onNameManuallyEdited?.();
        const nextArea = { ...areaRef.current, label: value.slice(0, 30) };
        areaRef.current = nextArea;
        onAreaChangeRef.current(nextArea);
    };

    const normalizeName = () => {
        if (areaRef.current.label.trim()) return;
        const nextArea = { ...areaRef.current, label: 'Custom' };
        areaRef.current = nextArea;
        onAreaChangeRef.current(nextArea);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="relative flex min-h-12 items-center justify-center px-14">
                <button type="button" onClick={onBack} aria-label="Back" className="absolute left-2 top-0 min-h-11 min-w-11 text-2xl text-ink">‹</button>
                <h1 className="truncate text-base font-bold text-ink">International area</h1>
            </div>

            <div ref={mapHostRef} className="relative h-[46dvh] min-h-72 max-h-[500px] w-full overflow-hidden bg-canvas">
                <MapContainer
                    center={[0, 0]}
                    zoom={2}
                    minZoom={1}
                    maxBounds={[[-85, -180], [85, 180]]}
                    maxBoundsViscosity={1}
                    zoomControl={false}
                    scrollWheelZoom
                    touchZoom
                    zoomSnap={0.1}
                    zoomDelta={0.25}
                    style={{ height: '100%', width: '100%' }}
                >
                    <MapBinder mapRef={mapRef} onReady={handleMapReady} />
                    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                </MapContainer>
                {frame && (
                    <div className="pointer-events-none absolute inset-0 z-[500] overflow-hidden">
                        <div
                            className="absolute border-2 border-action shadow-[0_0_0_9999px_rgba(23,32,51,0.30)]"
                            style={{ left: frame.left, top: frame.top, width: frame.size, height: frame.size }}
                            aria-label="Everything inside this square is your search area"
                        >
                            {(['north-west', 'north-east', 'south-west', 'south-east'] as const).map((corner) => (
                                <div
                                    key={corner}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`Resize area from ${corner.replace('-', ' ')}`}
                                    onPointerDown={(event) => beginResize(corner, event)}
                                    onPointerMove={resizeFrame}
                                    onPointerUp={endResize}
                                    onPointerCancel={endResize}
                                    className={`pointer-events-auto absolute h-11 w-11 touch-none ${HANDLE_CLASSES[corner]}`}
                                >
                                    {/* eslint-disable-next-line no-restricted-syntax -- circular handle is the established map-resize affordance. */}
                                    <span className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-action bg-surface" />
                                </div>
                            ))}
                            <button type="button" onClick={focusName} className="pointer-events-auto absolute bottom-3 left-1/2 min-h-9 -translate-x-1/2 whitespace-nowrap bg-action px-3 text-xs font-semibold text-white shadow-sm hover:bg-action-strong">
                                Use this area
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <p className="px-4 pt-3 text-xs text-ink-soft">Move, zoom or resize to customize your area.</p>
            <div className="flex-1 bg-surface px-4 pb-3 pt-4">
                <label htmlFor="onboarding-area-name" className="flex min-h-11 items-center gap-3">
                    <span className="shrink-0 text-sm font-semibold text-ink">Name</span>
                    <span className="relative min-w-0 flex-1">
                        <input
                            ref={nameInputRef}
                            id="onboarding-area-name"
                            aria-label="Name"
                            value={area.label}
                            maxLength={30}
                            onChange={(event) => updateName(event.target.value)}
                            onBlur={normalizeName}
                            className="min-h-11 w-full border border-line bg-surface px-3 pr-10 text-sm font-semibold text-ink focus:border-action focus:outline-none"
                        />
                        <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-action">✎</span>
                    </span>
                </label>
                <label className="mt-3 flex min-h-12 items-center justify-between border-t border-line py-3 text-sm font-semibold text-ink">
                    <span>New event alerts</span>
                    <input type="checkbox" checked={alertsEnabled} onChange={(event) => onAlertsChange(event.target.checked)} className="h-5 w-5 accent-action" />
                </label>
            </div>

            <div className="sticky bottom-0 z-[700] border-t border-line bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
                <button type="button" onClick={onContinue} className="min-h-12 w-full bg-action px-4 text-sm font-semibold text-white hover:bg-action-strong">{continueLabel}</button>
            </div>
        </div>
    );
}

function MapBinder({ mapRef, onReady }: { mapRef: React.MutableRefObject<L.Map | null>; onReady: () => void }) {
    const map = useMap();
    useEffect(() => {
        mapRef.current = map;
        const animationFrame = window.requestAnimationFrame(onReady);
        return () => {
            window.cancelAnimationFrame(animationFrame);
            mapRef.current = null;
        };
    }, [map, mapRef, onReady]);
    return null;
}
