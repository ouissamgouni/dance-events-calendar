import { useEffect } from 'react';
import { Circle, CircleMarker, MapContainer, TileLayer, useMap } from 'react-leaflet';
import { withRadiusKm, type RadiusSearchArea } from '../utils/searchArea';

interface Props {
    area: RadiusSearchArea;
    onChange: (area: RadiusSearchArea) => void;
    onSelectMapArea?: () => void;
    mapHeightClass?: string;
}

export default function RadiusAreaEditor({
    area,
    onChange,
    onSelectMapArea,
    mapHeightClass = 'h-64',
}: Props) {
    return (
        <div className="space-y-4">
            <div className={`${mapHeightClass} overflow-hidden bg-canvas`}>
                <MapContainer
                    center={[area.center_lat, area.center_lng]}
                    zoom={10}
                    scrollWheelZoom
                    touchZoom
                    zoomControl={false}
                    style={{ height: '100%', width: '100%' }}
                >
                    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                    <RadiusMapView area={area} />
                    <Circle
                        center={[area.center_lat, area.center_lng]}
                        radius={area.radius_km * 1000}
                        pathOptions={{ color: 'var(--color-action)', weight: 2, fillColor: 'var(--color-action)', fillOpacity: 0.14 }}
                    />
                    <CircleMarker
                        center={[area.center_lat, area.center_lng]}
                        radius={6}
                        pathOptions={{ color: 'var(--color-action)', fillColor: 'var(--color-action)', fillOpacity: 1 }}
                    />
                </MapContainer>
            </div>
            <section>
                <div className="mb-2 flex items-center justify-between">
                    <label htmlFor="area-distance" className="text-sm font-semibold text-ink">Distance</label>
                    <span className="text-sm font-semibold text-action">{area.radius_km} km</span>
                </div>
                <input
                    id="area-distance"
                    type="range"
                    min={5}
                    max={100}
                    step={5}
                    value={area.radius_km}
                    onChange={(event) => onChange(withRadiusKm(area, Number(event.target.value)))}
                    className="h-8 w-full accent-action"
                />
            </section>
            {onSelectMapArea && (
                <button
                    type="button"
                    onClick={onSelectMapArea}
                    className="text-sm font-medium text-action hover:underline"
                >
                    Select a map area instead
                </button>
            )}
        </div>
    );
}

function RadiusMapView({ area }: { area: RadiusSearchArea }) {
    const map = useMap();
    useEffect(() => {
        map.fitBounds(
            [[area.min_lat, area.min_lng], [area.max_lat, area.max_lng]],
            { padding: [16, 16], animate: false },
        );
    }, [area, map]);
    return null;
}
