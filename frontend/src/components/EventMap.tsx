import { useCallback, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { CalendarEvent } from '../types';

export interface MapBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

const EUROPE_CENTER: [number, number] = [48.5, 10.0];
const DEFAULT_ZOOM = 5;
const CITY_ZOOM = 13;

function makeColoredIcon(color: string | null): L.DivIcon {
    const fill = color || '#3b82f6';
    return L.divIcon({
        className: '',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14],
        html: `<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="14" r="11" fill="${fill}" stroke="white" stroke-width="2.5" />
            <circle cx="14" cy="14" r="4" fill="white" opacity="0.9" />
        </svg>`,
    });
}

interface Props {
    events: CalendarEvent[];
    focusedEvent?: CalendarEvent | null;
    onEventClick?: (event: CalendarEvent) => void;
    onBoundsChange?: (bounds: MapBounds) => void;
}

function BoundsReporter({ onBoundsChange }: { onBoundsChange?: (bounds: MapBounds) => void }) {
    const map = useMap();
    const timerRef = useRef<ReturnType<typeof setTimeout>>();

    const reportBounds = useCallback(() => {
        if (!onBoundsChange) return;
        const b = map.getBounds();
        onBoundsChange({
            north: b.getNorth(),
            south: b.getSouth(),
            east: b.getEast(),
            west: b.getWest(),
        });
    }, [map, onBoundsChange]);

    useEffect(() => {
        const handler = () => {
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(reportBounds, 300);
        };
        map.on('moveend', handler);
        // Report initial bounds
        reportBounds();
        return () => {
            map.off('moveend', handler);
            clearTimeout(timerRef.current);
        };
    }, [map, reportBounds]);

    return null;
}

function MapController({ positions, focusedPosition }: { positions: [number, number][]; focusedPosition: [number, number] | null }) {
    const map = useMap();
    const prevFocused = useRef<[number, number] | null>(null);

    useEffect(() => {
        if (focusedPosition) {
            prevFocused.current = focusedPosition;
            map.flyTo(focusedPosition, CITY_ZOOM, { duration: 0.8 });
            return;
        }

        // Unfocused — zoom back to show all
        if (prevFocused.current !== null) {
            prevFocused.current = null;
            if (positions.length === 0) {
                map.flyTo(EUROPE_CENTER, DEFAULT_ZOOM, { duration: 0.8 });
            } else if (positions.length === 1) {
                map.flyTo(positions[0], CITY_ZOOM, { duration: 0.8 });
            } else {
                map.flyToBounds(L.latLngBounds(positions), { padding: [40, 40], duration: 0.8 });
            }
            return;
        }

        // Initial fit (no animation)
        if (positions.length === 0) {
            map.setView(EUROPE_CENTER, DEFAULT_ZOOM);
        } else if (positions.length === 1) {
            map.setView(positions[0], CITY_ZOOM);
        } else {
            map.fitBounds(L.latLngBounds(positions), { padding: [40, 40] });
        }
    }, [map, positions, focusedPosition]);

    return null;
}

export default function EventMap({ events, focusedEvent, onEventClick, onBoundsChange }: Props) {
    const geoEvents = useMemo(
        () => events.filter((e) => e.latitude != null && e.longitude != null),
        [events],
    );

    const positions = useMemo<[number, number][]>(
        () => geoEvents.map((e) => [e.latitude!, e.longitude!]),
        [geoEvents],
    );

    const focusedPosition = useMemo<[number, number] | null>(() => {
        if (!focusedEvent?.latitude || !focusedEvent?.longitude) return null;
        return [focusedEvent.latitude, focusedEvent.longitude];
    }, [focusedEvent]);

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
            center={EUROPE_CENTER}
            zoom={DEFAULT_ZOOM}
            className="h-full w-full rounded-xl shadow-sm"
            scrollWheelZoom={true}
        >
            <TileLayer
                attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            />
            <MapController positions={positions} focusedPosition={focusedPosition} />
            <BoundsReporter onBoundsChange={onBoundsChange} />
            {geoEvents.map((e) => (
                <Marker
                    key={e.event_id}
                    position={[e.latitude!, e.longitude!]}
                    icon={makeColoredIcon(e.color)}
                >
                    <Popup>
                        <div className="space-y-1 text-xs">
                            <p
                                className="font-semibold text-sm cursor-pointer hover:text-slate-600"
                                onClick={() => onEventClick?.(e)}
                            >
                                {e.title}
                            </p>
                            <p className="text-slate-500">{formatDate(e)}</p>
                            {e.location && (
                                <p className="text-slate-600">📍 {e.location}</p>
                            )}
                        </div>
                    </Popup>
                </Marker>
            ))}
        </MapContainer>
    );
}
