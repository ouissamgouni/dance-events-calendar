import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeocodeSuggestion, InterestProfile, PreferredAreaPayload } from '../api';
import { searchSuggestionAddress } from '../api';
import { AREA_PRESETS, clampArea, DEFAULT_AREA_BBOX, type AreaBbox } from '../constants/area';
import AreaMapPicker from './AreaMapPicker';
import PresetSection from './PresetSection';
import PresetCard from './PresetCard';
import RegionPill from './RegionPill';
import ScrollDotsIndicator from './ScrollDots';
import { useScrollDots } from '../hooks/useScrollDots';

// AreaEditor — the search-area sub-editor body used inside the FilterSheet's
// "Area" section. Applies live: picking a preset, searching a place, or
// dragging the map immediately updates the session area so the sheet's
// "Show N events" count reflects the choice. "Set default" persists the
// current area to the active profile.
//
// Square corners, blue-500 primary, secondary slate chrome per
// .github/instructions/frontend.instructions.md.

const WORLDWIDE_AREA: PreferredAreaPayload =
    AREA_PRESETS.find((preset) => preset.label === 'Worldwide') ?? DEFAULT_AREA_BBOX;

// Shorter chip labels for tight preset rows (matches the reference UI).
const CHIP_LABELS: Record<string, string> = {
    'North America': 'N. America',
    'South America': 'S. America',
};

export interface AreaEditorProps {
    /** Current effective area, or ``null`` when browsing worldwide. */
    value: PreferredAreaPayload | null;
    /** The user's saved default area (fallback to the app default). */
    myArea: PreferredAreaPayload;
    /** Display name for the saved-area chip (defaults to "My area"). */
    myAreaLabel?: string;
    /** Saved profile areas offered as area-only shortcuts. */
    profileAreas?: InterestProfile[] | null;
    /** Apply the chosen area for this session (``null`` = worldwide). */
    onApply: (area: PreferredAreaPayload | null) => void;
    /** Persist the chosen area to the user's profile (explicit opt-in). */
    onSetDefault?: (area: PreferredAreaPayload) => Promise<void> | void;
    /** Number of events inside the current area (shown on the info card). */
    eventCount?: number;
}

export default function AreaEditor({ value, myArea, myAreaLabel, profileAreas, onApply, onSetDefault, eventCount }: AreaEditorProps) {
    const myAreaText = myAreaLabel ?? 'My area';
    const anywhere = value == null;
    const [savingDefault, setSavingDefault] = useState(false);
    const [query, setQuery] = useState('');
    const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searching, setSearching] = useState(false);
    const [centerOverride, setCenterOverride] = useState<{ lat: number; lng: number; zoom?: number } | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const searchBoxRef = useRef<HTMLDivElement>(null);
    const pendingSearchLabelRef = useRef<string | null>(null);
    const regionsScrollerRef = useRef<HTMLDivElement>(null);

    const isMyArea = !anywhere
        && value!.min_lat === myArea.min_lat
        && value!.min_lng === myArea.min_lng
        && value!.max_lat === myArea.max_lat
        && value!.max_lng === myArea.max_lng;

    // Continents (exclude "Worldwide", always show all for REGIONS section).
    const continents = AREA_PRESETS.filter((preset) => preset.label !== 'Worldwide');
    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(regionsScrollerRef, [continents.length]);
    const matchesPreset = (preset: AreaBbox): boolean => !anywhere
        && value!.min_lat === preset.min_lat
        && value!.min_lng === preset.min_lng
        && value!.max_lat === preset.max_lat
        && value!.max_lng === preset.max_lng;
    const matchesProfileArea = (profile: InterestProfile): boolean => !anywhere
        && value!.label === profile.area_label
        && value!.min_lat === profile.min_lat
        && value!.min_lng === profile.min_lng
        && value!.max_lat === profile.max_lat
        && value!.max_lng === profile.max_lng;
    const myAreaMatchesProfile = !!profileAreas?.some((profile) =>
        profile.min_lat === myArea.min_lat
        && profile.min_lng === myArea.min_lng
        && profile.max_lat === myArea.max_lat
        && profile.max_lng === myArea.max_lng
    );
    const applyProfileArea = (profile: InterestProfile) => onApply({
        label: profile.area_label,
        min_lat: profile.min_lat,
        min_lng: profile.min_lng,
        max_lat: profile.max_lat,
        max_lng: profile.max_lng,
    });

    const matchedPreset = anywhere ? null : continents.find(matchesPreset) ?? null;
    const currentLabel = anywhere
        ? 'Anywhere'
        : isMyArea
            ? myAreaText
            : (matchedPreset?.label ?? value!.label ?? 'Custom area');

    const runSearch = useCallback(async (q: string) => {
        if (q.trim().length < 3) {
            setSuggestions([]);
            setSearchOpen(false);
            return;
        }
        setSearching(true);
        try {
            const results = await searchSuggestionAddress(q.trim());
            setSuggestions(results);
            setSearchOpen(results.length > 0);
        } catch {
            setSuggestions([]);
            setSearchOpen(false);
        } finally {
            setSearching(false);
        }
    }, []);

    const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        setQuery(v);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => runSearch(v), 300);
    };

    const handlePickSuggestion = (s: GeocodeSuggestion) => {
        setQuery(s.display_name);
        pendingSearchLabelRef.current = s.display_name.slice(0, 120);
        setSuggestions([]);
        setSearchOpen(false);
        // Recenter the map on the place; the picker's live-apply commits the
        // resulting bbox back through onApply.
        setCenterOverride({ lat: s.latitude, lng: s.longitude, zoom: 9 });
    };

    const clearSearch = () => {
        setQuery('');
        setSuggestions([]);
        setSearchOpen(false);
    };

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
                setSearchOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleSetDefault = async () => {
        if (anywhere || !onSetDefault) return;
        setSavingDefault(true);
        try {
            await onSetDefault(clampArea(value!));
        } finally {
            setSavingDefault(false);
        }
    };

    const cardTitle = currentLabel === 'Anywhere' || currentLabel === myAreaText || currentLabel === 'Custom area'
        ? currentLabel
        : `${CHIP_LABELS[currentLabel] ?? currentLabel} area`;

    return (
        <div className="flex flex-col gap-3">
            {/* Search a place (optional). */}
            <div ref={searchBoxRef} className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">
                    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                        <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8" />
                        <path d="m17 17-3.2-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                </span>
                <input
                    type="text"
                    value={query}
                    onChange={handleQueryChange}
                    onFocus={() => suggestions.length > 0 && setSearchOpen(true)}
                    placeholder="Search city or region"
                    // eslint-disable-next-line no-restricted-syntax -- pill search field matches the provided filter-sheet design reference
                    className="w-full rounded-full border border-line bg-surface py-2.5 pl-9 pr-9 text-sm text-ink placeholder:text-ink-soft focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                    data-testid="area-editor-search"
                />
                {searching && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-soft">…</span>
                )}
                {!searching && query.length > 0 && (
                    <button
                        type="button"
                        onClick={clearSearch}
                        aria-label="Clear search"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-soft hover:text-ink"
                    >
                        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path d="M10 8.586 6.05 4.636 4.636 6.05 8.586 10l-3.95 3.95 1.414 1.414L10 11.414l3.95 3.95 1.414-1.414L11.414 10l3.95-3.95-1.414-1.414L10 8.586Z" />
                        </svg>
                    </button>
                )}
                {searchOpen && suggestions.length > 0 && (
                    <ul className="absolute z-[600] mt-1 max-h-52 w-full overflow-auto rounded-card border border-line bg-surface py-1 shadow-lg">
                        {suggestions.map((s, i) => (
                            <li key={`${s.display_name}-${i}`}>
                                <button
                                    type="button"
                                    onClick={() => handlePickSuggestion(s)}
                                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-canvas"
                                >
                                    <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true">
                                        <path d="M10 18s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10z" />
                                        <circle cx="10" cy="8" r="2" fill="white" />
                                    </svg>
                                    <span>{s.display_name}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Preset sections: YOUR AREAS and REGIONS. */}
            {/* YOUR AREAS: profiles + my area as cards. */}
            <PresetSection title="Your Areas">
                {/* My area card (if not duplicate profile). */}
                {!myAreaMatchesProfile && (
                    <PresetCard
                        label={myAreaText}
                        subLabel="Default area"
                        isActive={isMyArea}
                        onClick={() => onApply(myArea)}
                        testId="area-editor-my-area"
                    />
                )}
                {/* Profile area cards. */}
                {profileAreas?.map((profile) => (
                    <PresetCard
                        key={profile.id}
                        label={profile.area_label}
                        subLabel={`From your '${profile.label}' profile`}
                        isActive={matchesProfileArea(profile)}
                        onClick={() => applyProfileArea(profile)}
                        testId={`area-editor-profile-area-${profile.id}`}
                    />
                ))}
            </PresetSection>

            {/* REGIONS: continents + anywhere as pills with horizontal scroll. */}
            <div className="flex flex-col gap-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wide text-ink-soft">Regions</h3>
                <div ref={regionsScrollerRef} className="flex gap-2 overflow-x-auto scrollbar-hide px-2 py-2" aria-label="Regions carousel">
                    {continents.map((preset) => (
                        <RegionPill
                            key={preset.label}
                            label={CHIP_LABELS[preset.label] ?? preset.label}
                            isActive={matchesPreset(preset)}
                            onClick={() => onApply(preset)}
                            testId={`area-editor-preset-${preset.label.toLowerCase().replace(/\s+/g, '-')}`}
                        />
                    ))}
                    {/* Anywhere option (Worldwide area). */}
                    <RegionPill
                        label="Anywhere"
                        isActive={anywhere}
                        onClick={() => onApply(null)}
                        testId="area-editor-anywhere"
                    />
                </div>
                <ScrollDotsIndicator
                    count={dotCount}
                    activeIndex={activeIndex}
                    onSelect={scrollToIndex}
                    label="Regions carousel pages"
                />
            </div>

            {/* Map picker (drag/zoom to a custom area). */}
            <AreaMapPicker
                value={anywhere ? WORLDWIDE_AREA : value!}
                onChange={(area) => {
                    const searchLabel = pendingSearchLabelRef.current;
                    pendingSearchLabelRef.current = null;
                    onApply(searchLabel ? { ...area, label: searchLabel } : area);
                }}
                mapHeightClass="h-72"
                showPresets={false}
                autoCommit
                centerOverride={centerOverride}
            />

            {/* Current-area info card. */}
            <div
                className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3"
                data-testid="area-editor-current-label"
            >
                <span className="text-action" aria-hidden="true">
                    {anywhere ? (
                        <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6">
                            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                            <path d="M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3Z" stroke="currentColor" strokeWidth="1.8" />
                        </svg>
                    ) : (
                        <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6">
                            <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                            <circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.8" />
                        </svg>
                    )}
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{cardTitle}</p>
                    {typeof eventCount === 'number' && (
                        <p className="text-xs text-ink-soft">
                            {eventCount} {eventCount === 1 ? 'event' : 'events'} in this area
                        </p>
                    )}
                </div>
                {onSetDefault && !anywhere && (
                    <button
                        type="button"
                        onClick={handleSetDefault}
                        disabled={savingDefault}
                        className="shrink-0 text-xs font-medium text-action hover:underline disabled:opacity-50 disabled:hover:no-underline"
                        data-testid="area-editor-set-default"
                    >
                        {savingDefault ? 'Saving…' : 'Set default'}
                    </button>
                )}
            </div>
        </div>
    );
}
