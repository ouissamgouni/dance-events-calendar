import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { CalendarEvent } from '../types';
import SaveEventButton from './SaveEventButton';
import TagBadges from './TagBadges';

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

function makeHighlightedIcon(color: string | null): L.DivIcon {
    const fill = color || '#3b82f6';
    return L.divIcon({
        className: '',
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -18],
        html: `<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
            <circle cx="18" cy="18" r="16" fill="${fill}" opacity="0.25" />
            <circle cx="18" cy="18" r="12" fill="${fill}" stroke="white" stroke-width="3" />
            <circle cx="18" cy="18" r="4.5" fill="white" opacity="0.9" />
        </svg>`,
    });
}

interface Props {
    events: CalendarEvent[];
    focusedEvent?: CalendarEvent | null;
    onEventClick?: (event: CalendarEvent) => void;
    onBoundsChange?: (bounds: MapBounds) => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
}

function BoundsReporter({ onBoundsChange }: { onBoundsChange?: (bounds: MapBounds) => void }) {
    const map = useMap();
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

function MapController({
    positions,
    focusedEventId,
    focusedPosition,
    markerRefs,
}: {
    positions: [number, number][];
    focusedEventId: string | null;
    focusedPosition: [number, number] | null;
    markerRefs: MutableRefObject<Map<string, L.Marker>>;
}) {
    const map = useMap();
    const prevFocused = useRef<[number, number] | null>(null);

    useEffect(() => {
        // Close any open popups when focus changes
        map.closePopup();

        if (focusedPosition) {
            prevFocused.current = focusedPosition;
            const openPopup = () => {
                if (!focusedEventId) return;
                const marker = markerRefs.current.get(focusedEventId);
                if (marker) {
                    marker.openPopup();
                }
            };

            map.once('moveend', openPopup);
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
    }, [focusedEventId, map, markerRefs, positions, focusedPosition]);

    return null;
}

export default function EventMap({ events, focusedEvent, onEventClick, onBoundsChange, hoveredEventId, onEventHover }: Props) {
    const markerRefs = useRef(new Map<string, L.Marker>());
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
            center={EUROPE_CENTER}
            zoom={DEFAULT_ZOOM}
            className="h-full w-full rounded-xl shadow-sm"
            scrollWheelZoom={true}
        >
            <TileLayer
                attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            />
            <MapController
                positions={positions}
                focusedEventId={focusedEventId}
                focusedPosition={focusedPosition}
                markerRefs={markerRefs}
            />
            <BoundsReporter onBoundsChange={onBoundsChange} />
            {geoEvents.map((e) => (
                <Marker
                    key={e.event_id}
                    ref={(marker) => registerMarker(e.event_id, marker)}
                    position={[e.latitude!, e.longitude!]}
                    icon={hoveredEventId === e.event_id ? makeHighlightedIcon(e.color) : makeColoredIcon(e.color)}
                    eventHandlers={{
                        mouseover: () => onEventHover?.(e.event_id),
                        mouseout: () => onEventHover?.(null),
                    }}
                >
                    <Popup>
                        <div className="space-y-1.5 text-xs min-w-[180px]">
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
                            {e.tags?.length > 0 && (
                                <TagBadges tags={e.tags} maxVisible={3} />
                            )}
                            <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                                <SaveEventButton eventId={e.event_id} appearance="icon" size="sm" stopPropagation />
                                <button
                                    onClick={() => onEventClick?.(e)}
                                    className="text-[10px] font-medium text-rose-500 hover:text-rose-700"
                                >
                                    Details →
                                </button>
                            </div>
                        </div>
                    </Popup>
                </Marker>
            ))}
        </MapContainer>
    );
}
