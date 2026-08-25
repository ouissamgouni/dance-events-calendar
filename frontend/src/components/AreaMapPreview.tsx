import { useEffect } from 'react';
import { Circle, CircleMarker, MapContainer, Rectangle, TileLayer, useMap } from 'react-leaflet';
import type { SearchArea } from '../utils/searchArea';

interface Props {
    area: SearchArea;
    className?: string;
}

export default function AreaMapPreview({ area, className = 'h-16 w-24' }: Props) {
    const bounds: [[number, number], [number, number]] = [
        [area.min_lat, area.min_lng],
        [area.max_lat, area.max_lng],
    ];
    return (
        <div className={`${className} shrink-0 overflow-hidden bg-canvas`} aria-hidden="true">
            <MapContainer
                bounds={bounds}
                boundsOptions={{ padding: [6, 6] }}
                style={{ height: '100%', width: '100%' }}
                dragging={false}
                scrollWheelZoom={false}
                doubleClickZoom={false}
                zoomControl={false}
                attributionControl={false}
                keyboard={false}
            >
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <PreviewBounds area={area} />
                {area.kind === 'bbox' ? (
                    <Rectangle
                        bounds={bounds}
                        pathOptions={{ color: 'var(--color-action)', weight: 1.5, fillColor: 'var(--color-action)', fillOpacity: 0.12 }}
                    />
                ) : (
                    <>
                        <Circle
                            center={[area.center_lat, area.center_lng]}
                            radius={area.radius_km * 1000}
                            pathOptions={{ color: 'var(--color-action)', weight: 1.5, fillColor: 'var(--color-action)', fillOpacity: 0.12 }}
                        />
                        <CircleMarker
                            center={[area.center_lat, area.center_lng]}
                            radius={2.5}
                            pathOptions={{ color: 'var(--color-action)', fillColor: 'var(--color-action)', fillOpacity: 1 }}
                        />
                    </>
                )}
            </MapContainer>
        </div>
    );
}

function PreviewBounds({ area }: { area: SearchArea }) {
    const map = useMap();
    useEffect(() => {
        map.fitBounds(
            [[area.min_lat, area.min_lng], [area.max_lat, area.max_lng]],
            { padding: [6, 6], animate: false },
        );
    }, [area, map]);
    return null;
}
