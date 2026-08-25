import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { GeocodeSuggestion, InterestProfile, PreferredAreaPayload } from '../api';
import { searchSuggestionAddress } from '../api';
import { AREA_PRESETS } from '../constants/area';
import {
    bboxSearchArea,
    radiusToCustomBbox,
    searchAreaFromProfile,
    searchAreaFromSuggestion,
    searchAreasEqual,
    toPreferredArea,
    type SearchArea,
} from '../utils/searchArea';
import AreaMapPreview from './AreaMapPreview';
import PresetCard from './PresetCard';
import PresetSection from './PresetSection';
import RadiusAreaEditor from './RadiusAreaEditor';
import RegionPill from './RegionPill';
import SquareAreaMapEditor from './SquareAreaMapEditor';

const CHIP_LABELS: Record<string, string> = {
    'North America': 'N. America',
};

type AreaValue = SearchArea | PreferredAreaPayload;

export interface AreaEditorProps {
    value: AreaValue | null;
    myArea: AreaValue;
    myAreaLabel?: string;
    profileAreas?: InterestProfile[] | null;
    onApply?: (area: PreferredAreaPayload | null) => void;
    onUseArea?: (area: SearchArea) => void;
    onExploreMap?: (area: SearchArea) => void;
    showSavedAreas?: boolean;
    eventCount?: number;
}

function normalizeArea(value: AreaValue, source: 'preference' | 'custom' = 'preference'): SearchArea {
    return 'kind' in value ? value : bboxSearchArea(value, source);
}

export default function AreaEditor({
    value,
    myArea,
    myAreaLabel,
    profileAreas,
    onApply,
    onUseArea,
    onExploreMap,
    showSavedAreas = true,
}: AreaEditorProps) {
    const initialArea = value ? normalizeArea(value) : normalizeArea(myArea, 'preference');
    const [draft, setDraft] = useState<SearchArea>(initialArea);
    const [selectionVersion, setSelectionVersion] = useState(0);
    const [query, setQuery] = useState('');
    const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searching, setSearching] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const searchBoxRef = useRef<HTMLDivElement>(null);

    const applyArea = (area: SearchArea) => {
        if (onUseArea) onUseArea(area);
        else onApply?.(toPreferredArea(area));
    };

    const chooseArea = (area: SearchArea) => {
        setDraft(area);
        setSelectionVersion((version) => version + 1);
        applyArea(area);
    };

    const adjustArea = (area: SearchArea) => {
        setDraft(area);
        applyArea(area);
    };

    const runSearch = useCallback(async (search: string) => {
        if (search.trim().length < 3) {
            setSuggestions([]);
            setSearchOpen(false);
            return;
        }
        setSearching(true);
        try {
            const results = await searchSuggestionAddress(search.trim());
            setSuggestions(results);
            setSearchOpen(results.length > 0);
        } catch {
            setSuggestions([]);
            setSearchOpen(false);
        } finally {
            setSearching(false);
        }
    }, []);

    useEffect(() => {
        const closeSearch = (event: MouseEvent) => {
            if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) {
                setSearchOpen(false);
            }
        };
        document.addEventListener('mousedown', closeSearch);
        return () => document.removeEventListener('mousedown', closeSearch);
    }, []);

    const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
        const nextQuery = event.target.value;
        setQuery(nextQuery);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => void runSearch(nextQuery), 300);
    };

    const pickSuggestion = (suggestion: GeocodeSuggestion) => {
        const name = suggestion.name?.trim() || suggestion.display_name;
        const locationLabel = suggestion.country && suggestion.country !== name
            ? `${name}, ${suggestion.country}`
            : name;
        setQuery(locationLabel);
        setSuggestions([]);
        setSearchOpen(false);
        chooseArea(searchAreaFromSuggestion(suggestion));
    };

    const profileEntries = profileAreas?.map((profile) => ({
        profile,
        area: searchAreaFromProfile(profile),
    })) ?? [];
    const myAreaEntry = normalizeArea(
        'kind' in myArea ? myArea : { ...myArea, label: myAreaLabel ?? myArea.label },
        'preference',
    );
    const myAreaMatchesProfile = profileEntries.some(({ area }) => searchAreasEqual(area, myAreaEntry));
    const quickAreas = AREA_PRESETS.filter((preset) => preset.label !== 'Worldwide');
    const isSelectedArea = (area: SearchArea) => searchAreasEqual(draft, area) && draft.label === area.label;

    return (
        <div className="flex min-h-full flex-col gap-3" data-testid="area-editor">
            <div ref={searchBoxRef} className="relative shrink-0">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" aria-hidden="true">⌕</span>
                <input
                    type="search"
                    value={query}
                    onChange={handleQueryChange}
                    onFocus={() => suggestions.length > 0 && setSearchOpen(true)}
                    placeholder="Search city, country or region"
                    aria-label="Search city, country or region"
                    className="min-h-11 w-full rounded-card border border-line bg-surface py-2.5 pl-9 pr-9 text-sm text-ink placeholder:text-ink-soft focus:border-action focus:outline-none"
                    data-testid="area-editor-search"
                />
                {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-soft">…</span>}
                {searchOpen && suggestions.length > 0 && (
                    <ul className="absolute z-[800] mt-1 max-h-60 w-full overflow-y-auto rounded-card border border-line bg-surface py-1 shadow-lg">
                        {suggestions.map((suggestion, index) => {
                            const name = suggestion.name?.trim() || suggestion.display_name;
                            const title = suggestion.country && suggestion.country !== name
                                ? `${name}, ${suggestion.country}`
                                : name;
                            return (
                                <li key={`${suggestion.latitude}-${suggestion.longitude}-${index}`}>
                                    <button
                                        type="button"
                                        onClick={() => pickSuggestion(suggestion)}
                                        className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left hover:bg-canvas"
                                    >
                                        <span aria-hidden="true" className="text-action">⌖</span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-semibold text-ink">{title}</span>
                                            <span className="block text-xs text-ink-soft">{suggestion.type_label ?? 'Place'}</span>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {showSavedAreas && (profileEntries.length > 0 || !myAreaMatchesProfile) && (
                <PresetSection title="Your Areas" carouselLabel="Your areas">
                    {!myAreaMatchesProfile && (
                        <PresetCard
                            label={myAreaLabel ?? myAreaEntry.label}
                            subLabel="Default area"
                            isActive={isSelectedArea(myAreaEntry)}
                            onClick={() => chooseArea(myAreaEntry)}
                            preview={<AreaMapPreview area={myAreaEntry} className="h-12 w-16 rounded" />}
                            testId="area-editor-my-area"
                        />
                    )}
                    {profileEntries.map(({ profile, area }) => (
                        <PresetCard
                            key={profile.id}
                            label={profile.area_label}
                            subLabel={`From profile ${profile.label}`}
                            isActive={isSelectedArea(area)}
                            onClick={() => chooseArea(area)}
                            preview={<AreaMapPreview area={area} className="h-12 w-16 rounded" />}
                            testId={`area-editor-profile-area-${profile.id}`}
                        />
                    ))}
                </PresetSection>
            )}

            <PresetSection title="Quick Areas" carouselLabel="Quick areas">
                {quickAreas.map((preset) => {
                    const area = bboxSearchArea(preset, 'preset');
                    return (
                        <RegionPill
                            key={preset.label}
                            label={CHIP_LABELS[preset.label] ?? preset.label}
                            isActive={isSelectedArea(area)}
                            onClick={() => chooseArea(area)}
                            testId={`area-editor-preset-${preset.label.toLowerCase().replace(/\s+/g, '-')}`}
                        />
                    );
                })}
            </PresetSection>

            <div className="min-h-72 flex-1">
                {draft.kind === 'radius' ? (
                    <RadiusAreaEditor
                        key={`radius-${selectionVersion}`}
                        area={draft}
                        onChange={adjustArea}
                        onSelectMapArea={() => chooseArea(radiusToCustomBbox(draft))}
                        mapHeightClass="h-[min(42dvh,380px)] min-h-72"
                    />
                ) : (
                    <>
                        <SquareAreaMapEditor
                            key={`bbox-${selectionVersion}`}
                            area={draft}
                            onChange={adjustArea}
                            mapHeightClass="h-[min(42dvh,380px)] min-h-72"
                        />
                        <p className="px-1 pt-2 text-xs text-ink-soft">Move, zoom or resize to refine the area.</p>
                    </>
                )}
            </div>

            {onExploreMap && (
                <button
                    type="button"
                    onClick={() => onExploreMap(draft)}
                    className="min-h-11 self-start px-1 text-sm font-semibold text-action"
                >
                    Explore map ↗
                </button>
            )}
        </div>
    );
}
