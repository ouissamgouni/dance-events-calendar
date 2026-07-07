import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CircleMarker, MapContainer, Rectangle, TileLayer, useMap } from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';
import {
    createInterestProfile,
    fetchTagGroups,
    searchSuggestionAddress,
    type GeocodeSuggestion,
    type HomeLocationPayload,
    type PreferredAreaPayload,
} from '../api';
import TagsPicker, { type TagsPickerValue } from '../components/TagsPicker';
import { clampArea } from '../constants/area';
import { usePreferences } from '../context/PreferencesContext';
import type { TagGroup } from '../types';

const RADIUS_MIN_KM = 5;
const RADIUS_MAX_KM = 150;
const RADIUS_DEFAULT_KM = 10;

/** Derive a square-ish bbox centered on ``pin`` covering ``radiusKm`` in
 * every direction. Longitude spans shrink toward the poles because
 * meridians converge; we correct for that with cos(lat). */
function bboxFromPinRadius(pin: { lat: number; lng: number }, radiusKm: number, label: string): PreferredAreaPayload {
    const latRad = (pin.lat * Math.PI) / 180;
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.max(0.1, Math.cos(latRad)));
    return clampArea({
        min_lat: pin.lat - dLat,
        min_lng: pin.lng - dLng,
        max_lat: pin.lat + dLat,
        max_lng: pin.lng + dLng,
        label,
    });
}

/** Recenters the Leaflet map imperatively whenever the pin or radius
 * changes — react-leaflet has no declarative "recenter" prop. */
function MapRecenter({ pin, radiusKm }: { pin: { lat: number; lng: number }; radiusKm: number }) {
    const map = useMap();
    useEffect(() => {
        const bbox = bboxFromPinRadius(pin, radiusKm, 'preview');
        map.fitBounds(
            [
                [bbox.min_lat, bbox.min_lng],
                [bbox.max_lat, bbox.max_lng],
            ],
            { padding: [20, 20], animate: true },
        );
    }, [map, pin.lat, pin.lng, radiusKm]);
    return null;
}

export default function OnboardingLocal() {
    const navigate = useNavigate();
    const [sp] = useSearchParams();
    const next = sp.get('next') || '/';
    const followPath = `/onboarding/follow?next=${encodeURIComponent(next)}`;
    const { prefs, setPrefs } = usePreferences();

    const [pin, setPin] = useState<{ lat: number; lng: number } | null>(
        prefs.homeLocation ? { lat: prefs.homeLocation.lat, lng: prefs.homeLocation.lng } : null,
    );
    const [cityLabel, setCityLabel] = useState<string>(prefs.homeLocation?.label ?? '');
    const [radiusKm, setRadiusKm] = useState<number>(RADIUS_DEFAULT_KM);
    const [matchesEnabled, setMatchesEnabled] = useState<boolean>(true);

    // Dance styles picker — same list the preferences step shows so
    // users see a familiar list of tags to seed the local profile with.
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [tagsLoading, setTagsLoading] = useState(true);
    const [danceValue, setDanceValue] = useState<TagsPickerValue>({ selectedTagIds: [], freeTexts: {} });
    const initialTagIdsRef = useRef(prefs.tagIds);
    const danceSeededRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        fetchTagGroups({ scope: 'event', onboarding: true })
            .then((groups) => { if (!cancelled) setTagGroups(groups); })
            .catch(() => { if (!cancelled) setTagGroups([]); })
            .finally(() => { if (!cancelled) setTagsLoading(false); });
        return () => { cancelled = true; };
    }, []);

    const danceGroup = useMemo(
        () => tagGroups.find((g) => g.slug === 'dance-style' && g.enabled !== false) ?? null,
        [tagGroups],
    );

    // Prefill dance selection from what the user picked in the previous
    // (active-profile) step, which mirrors its tags into prefs.tagIds.
    // Guarded by a ref so a later user edit isn't overwritten.
    useEffect(() => {
        if (tagsLoading || danceSeededRef.current || !danceGroup) return;
        const seeded = danceGroup.tags
            .filter((t) => initialTagIdsRef.current.includes(t.id))
            .map((t) => t.id);
        if (seeded.length > 0) {
            setDanceValue({ selectedTagIds: seeded, freeTexts: {} });
        }
        danceSeededRef.current = true;
    }, [tagsLoading, danceGroup]);

    // City search state.
    const [searchInput, setSearchInput] = useState('');
    const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
    const [searching, setSearching] = useState(false);
    const [suggestOpen, setSuggestOpen] = useState(false);
    const searchDebounceRef = useRef<number | null>(null);
    const searchReqIdRef = useRef(0);

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [geoLoading, setGeoLoading] = useState(false);

    // Debounced city search: fires 300ms after the user stops typing.
    useEffect(() => {
        if (searchDebounceRef.current != null) window.clearTimeout(searchDebounceRef.current);
        const q = searchInput.trim();
        if (q.length < 2) {
            setSuggestions([]);
            setSearching(false);
            return;
        }
        setSearching(true);
        const reqId = ++searchReqIdRef.current;
        searchDebounceRef.current = window.setTimeout(async () => {
            try {
                const results = await searchSuggestionAddress(q);
                if (reqId !== searchReqIdRef.current) return;
                setSuggestions(results.slice(0, 6));
                setSuggestOpen(true);
            } finally {
                if (reqId === searchReqIdRef.current) setSearching(false);
            }
        }, 300);
        return () => {
            if (searchDebounceRef.current != null) window.clearTimeout(searchDebounceRef.current);
        };
    }, [searchInput]);

    const handlePickSuggestion = (s: GeocodeSuggestion) => {
        setPin({ lat: s.latitude, lng: s.longitude });
        setCityLabel(s.display_name);
        setSearchInput(s.display_name);
        setSuggestOpen(false);
    };

    const handleUseCurrentLocation = () => {
        if (!('geolocation' in navigator)) {
            setError('Geolocation is not available in this browser.');
            return;
        }
        setGeoLoading(true);
        setError(null);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setPin({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                setCityLabel('Local');
                setSearchInput('');
                setGeoLoading(false);
            },
            (err) => {
                setGeoLoading(false);
                setError(err.message || 'Could not read your current location.');
            },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
        );
    };

    const canContinue = pin != null && !saving;

    const bboxPreview = useMemo(() => {
        if (!pin) return null;
        return bboxFromPinRadius(pin, radiusKm, cityLabel.trim() || 'Local');
    }, [pin, radiusKm, cityLabel]);

    const handleContinue = async () => {
        // Blocker: user must set a pin before continuing. The button is
        // already disabled, but guard here defensively in case a screen
        // reader / keyboard user forces the click.
        if (!pin || !bboxPreview) {
            setError('Pick a city or use your current location before continuing.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const homePayload: HomeLocationPayload = {
                lat: pin.lat,
                lng: pin.lng,
                label: cityLabel.trim() || 'Local',
            };
            // Save the home pin (used for future radius UIs). We do NOT
            // overwrite ``prefs.area`` here because the preferences step
            // already seeded the active profile's wider area; that path
            // mirrors area ↔ prefs. The local profile is a *separate*
            // profile with its own bbox.
            await setPrefs({ homeLocation: homePayload });
            // Create a NEW profile (not update the active one). Activate
            // it so the Explorer / For You immediately focus on the
            // local footprint; the wider preferences profile is
            // preserved and can be re-activated from Settings.
            await createInterestProfile({
                label: bboxPreview.label,
                min_lat: bboxPreview.min_lat,
                min_lng: bboxPreview.min_lng,
                max_lat: bboxPreview.max_lat,
                max_lng: bboxPreview.max_lng,
                dance_tag_ids: danceValue.selectedTagIds,
                // Reach is intentionally left empty: the local profile is
                // defined by its bbox, not by a reach constraint. Users
                // can add reach tags later from Settings.
                reach_tag_ids: [],
                matches_enabled: matchesEnabled,
                // Keep the preferences profile (step 1) active. The local
                // profile is stored alongside it and can be activated
                // later from Settings.
                is_active: false,
            });
            navigate(followPath, { replace: true });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save your local profile');
        } finally {
            setSaving(false);
        }
    };

    // Skip: no local profile created; user proceeds with the wider
    // preferences profile as their sole active profile.
    const handleSkip = () => {
        navigate(followPath, { replace: true });
    };

    // Center used only for the initial map render; MapRecenter takes over
    // once ``pin`` is set.
    const initialCenter: [number, number] = pin ? [pin.lat, pin.lng] : [48.8566, 2.3522];
    const bboxBounds: LatLngBoundsExpression | null = bboxPreview
        ? [
              [bboxPreview.min_lat, bboxPreview.min_lng],
              [bboxPreview.max_lat, bboxPreview.max_lng],
          ]
        : null;

    return (
        <div className="mx-auto max-w-2xl px-4 py-4">
            <div className="mb-3 flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-lg font-semibold text-slate-900">Set your local area</h1>
                    <p className="mt-0.5 text-xs text-slate-600">
                        Search a city or use your current location. Your alert covers a box centered on that pin — resize it with the slider.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleSkip}
                    className="text-sm text-slate-500 hover:text-slate-700"
                    aria-label="Skip local area setup"
                >
                    Skip
                </button>
            </div>

            {error && (
                <div className="mb-3 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    {error}
                </div>
            )}

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Dance styles
                </label>
                <p className="mb-1.5 text-xs text-slate-500">
                    Optional — leave empty to match every style within your local area.
                </p>
                {tagsLoading ? (
                    <p className="text-sm text-slate-400">Loading tags…</p>
                ) : !danceGroup ? (
                    <p className="text-sm text-slate-500">No dance-style tags are available yet.</p>
                ) : (
                    <TagsPicker
                        tagGroups={[danceGroup]}
                        value={danceValue}
                        onChange={setDanceValue}
                        allowFreeText={false}
                        searchable
                    />
                )}
            </section>

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <label htmlFor="onboarding-local-city" className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    City
                </label>
                <div className="relative">
                    <input
                        id="onboarding-local-city"
                        type="text"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        onFocus={() => { if (suggestions.length > 0) setSuggestOpen(true); }}
                        onBlur={() => window.setTimeout(() => setSuggestOpen(false), 150)}
                        placeholder="Search a city (e.g. Berlin, Lisbon)"
                        className="w-full border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    {suggestOpen && suggestions.length > 0 && (
                        <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-auto border border-slate-200 bg-white shadow-sm">
                            {suggestions.map((s) => (
                                <li key={`${s.latitude},${s.longitude}`}>
                                    <button
                                        type="button"
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => handlePickSuggestion(s)}
                                        className="block w-full truncate px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
                                    >
                                        {s.display_name}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {searching && (
                        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
                            …
                        </span>
                    )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleUseCurrentLocation}
                        disabled={geoLoading}
                        className="border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {geoLoading ? 'Locating…' : 'Use my current location'}
                    </button>
                    {pin && (
                        <span className="truncate text-[11px] text-slate-500">
                            Pin: {pin.lat.toFixed(4)}, {pin.lng.toFixed(4)}
                        </span>
                    )}
                </div>
            </section>

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <label htmlFor="onboarding-local-radius" className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                        Radius
                    </label>
                    <span className="text-xs font-medium text-slate-700">{radiusKm} km</span>
                </div>
                <input
                    id="onboarding-local-radius"
                    type="range"
                    min={RADIUS_MIN_KM}
                    max={RADIUS_MAX_KM}
                    step={1}
                    value={radiusKm}
                    onChange={(e) => setRadiusKm(Number(e.target.value))}
                    className="w-full"
                />
                <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wide text-slate-400">
                    <span>{RADIUS_MIN_KM} km</span>
                    <span>{RADIUS_MAX_KM} km</span>
                </div>
            </section>

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Preview</span>
                    {bboxPreview && (
                        <span className="text-[11px] text-slate-500">
                            {bboxPreview.label}
                        </span>
                    )}
                </div>
                <div className="h-56 w-full overflow-hidden border border-slate-200">
                    <MapContainer
                        center={initialCenter}
                        zoom={pin ? 10 : 4}
                        scrollWheelZoom={false}
                        style={{ height: '100%', width: '100%' }}
                    >
                        <TileLayer
                            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        />
                        {pin && (
                            <>
                                <MapRecenter pin={pin} radiusKm={radiusKm} />
                                <CircleMarker
                                    center={[pin.lat, pin.lng]}
                                    radius={6}
                                    pathOptions={{ color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.9 }}
                                />
                                {bboxBounds && (
                                    <Rectangle
                                        bounds={bboxBounds}
                                        pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.08 }}
                                    />
                                )}
                            </>
                        )}
                    </MapContainer>
                </div>
                {!pin && (
                    <p className="mt-2 text-xs text-slate-500">
                        Pick a city or use your current location to see the coverage box.
                    </p>
                )}
            </section>

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <label className="flex items-start gap-3 text-sm text-slate-800">
                    <input
                        type="checkbox"
                        checked={matchesEnabled}
                        onChange={(e) => setMatchesEnabled(e.target.checked)}
                        className="mt-0.5 h-4 w-4"
                    />
                    <span>
                        <span className="block font-medium">Notify me about matching events</span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                            Get an email when a new event matches this local profile. You can change this later.
                        </span>
                    </span>
                </label>
            </section>

            <p className="mb-2 text-xs text-slate-500">
                You can rename this area or add more profiles later in Settings.
            </p>

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={() => void handleContinue()}
                    disabled={!canContinue}
                    title={pin ? undefined : 'Pick a city or use your current location first'}
                    className="bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Continue'}
                </button>
            </div>
        </div>
    );
}
