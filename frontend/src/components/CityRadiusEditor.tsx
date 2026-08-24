import { useEffect, useState } from 'react';
import { Circle, CircleMarker, MapContainer, TileLayer, useMap } from 'react-leaflet';
import {
    fetchPopularCities,
    searchSuggestionAddress,
    type GeocodeSuggestion,
    type HomeLocationPayload,
    type PopularCity,
} from '../api';
import { bboxFromPinRadius, type CityRadiusValue } from './onboarding/onboardingGeometry';

export default function CityRadiusEditor({ value, onChange }: { value: CityRadiusValue | null; onChange: (value: CityRadiusValue) => void }) {
    const [query, setQuery] = useState(value?.location.label ?? '');
    const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
    const [popularCities, setPopularCities] = useState<PopularCity[]>([]);
    const [geoLoading, setGeoLoading] = useState(false);
    const [geoError, setGeoError] = useState<string | null>(null);
    const radiusValues = [5, 10, 25, 50, 100] as const;

    useEffect(() => { void fetchPopularCities(5).then(setPopularCities).catch(() => setPopularCities([])); }, []);
    useEffect(() => {
        if (query.trim().length < 3 || query === value?.location.label) return;
        const timer = window.setTimeout(() => {
            void searchSuggestionAddress(query.trim()).then(setSuggestions).catch(() => setSuggestions([]));
        }, 300);
        return () => window.clearTimeout(timer);
    }, [query, value?.location.label]);

    const choose = (location: HomeLocationPayload) => {
        setQuery(location.label);
        setSuggestions([]);
        setGeoError(null);
        onChange({ location, radiusKm: value?.radiusKm ?? 25 });
    };

    const useCurrentLocation = () => {
        if (!('geolocation' in navigator)) {
            setGeoError('Geolocation is not available in this browser.');
            return;
        }
        setGeoLoading(true);
        setGeoError(null);
        navigator.geolocation.getCurrentPosition(
            (position) => {
                choose({ lat: position.coords.latitude, lng: position.coords.longitude, label: 'Current location' });
                setGeoLoading(false);
            },
            (error) => {
                setGeoLoading(false);
                setGeoError(error.message || 'Could not read your current location.');
            },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
        );
    };

    return (
        <div className="space-y-4">
            <div className="relative">
                <label htmlFor="profile-city" className="mb-2 block text-sm font-semibold text-ink">City</label>
                <input id="profile-city" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setSuggestions([]); }} placeholder="Search a city" className="min-h-11 w-full border border-line bg-surface px-3 text-sm text-ink focus:border-action focus:outline-none" />
                <button type="button" onClick={useCurrentLocation} disabled={geoLoading} className="mt-2 min-h-11 text-sm font-semibold text-action disabled:opacity-50">{geoLoading ? 'Finding your location…' : 'Use current location'}</button>
                {geoError && <p role="alert" className="mt-1 text-sm text-red-700">{geoError}</p>}
                {suggestions.length > 0 && query !== value?.location.label && <ul className="absolute z-[800] mt-1 max-h-52 w-full overflow-y-auto border border-line bg-surface shadow-lg">{suggestions.map((suggestion) => <li key={`${suggestion.latitude}-${suggestion.longitude}`}><button type="button" onClick={() => choose({ lat: suggestion.latitude, lng: suggestion.longitude, label: suggestion.display_name })} className="min-h-11 w-full px-3 text-left text-sm text-ink hover:bg-canvas">{suggestion.display_name}</button></li>)}</ul>}
                {!value && popularCities.length > 0 && <div className="mt-2 flex gap-2 overflow-x-auto pb-1 scrollbar-hide">{popularCities.map((city) => <button key={`${city.city}-${city.country ?? ''}`} type="button" onClick={() => choose({ lat: city.lat, lng: city.lng, label: [city.city, city.country].filter(Boolean).join(', ') })} className="min-h-10 shrink-0 border border-line bg-surface px-3 text-xs font-semibold text-ink">{city.city}</button>)}</div>}
            </div>
            {value && <>
                <div className="h-64 overflow-hidden border border-line">
                    <MapContainer center={[value.location.lat, value.location.lng]} zoom={10} scrollWheelZoom zoomControl={false} style={{ height: '100%', width: '100%' }}>
                        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                        <RadiusMapView value={value} />
                        <Circle center={[value.location.lat, value.location.lng]} radius={value.radiusKm * 1000} pathOptions={{ color: '#2563eb', weight: 2, fillColor: '#2563eb', fillOpacity: 0.14 }} />
                        <CircleMarker center={[value.location.lat, value.location.lng]} radius={6} pathOptions={{ color: '#2563eb', fillColor: '#2563eb', fillOpacity: 1 }} />
                    </MapContainer>
                </div>
                <section>
                    <div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold text-ink">Radius</span><span className="text-sm font-semibold text-action">{value.radiusKm} km</span></div>
                    <div className="grid grid-cols-5 gap-1">{radiusValues.map((radius) => <button key={radius} type="button" onClick={() => onChange({ ...value, radiusKm: radius })} className={radius === value.radiusKm ? 'min-h-11 bg-action text-xs font-semibold text-white' : 'min-h-11 border border-line bg-surface text-xs font-semibold text-ink'}>{radius}</button>)}</div>
                </section>
            </>}
        </div>
    );
}

function RadiusMapView({ value }: { value: CityRadiusValue }) {
    const map = useMap();
    useEffect(() => {
        const bounds = bboxFromPinRadius(value.location, value.radiusKm, value.location.label);
        map.fitBounds([[bounds.min_lat, bounds.min_lng], [bounds.max_lat, bounds.max_lng]], { padding: [16, 16], animate: false });
    }, [map, value]);
    return null;
}
