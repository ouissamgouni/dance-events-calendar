import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MapPin, Search, Star } from 'lucide-react';
import SubPage from './SubPage';
import { searchSuggestionAddress, type GeocodeSuggestion } from '../../api';
import { helpCls, inputCls } from './formState';
import PlaceAttribution from '../PlaceAttribution';
import { NO_PLACE, placeFromSuggestion, type Place } from '../../utils/placeFields';

interface Props {
    value: string;
    onSelect: (
        location: string,
        latitude: number | null,
        longitude: number | null,
        timezone: string | null,
        place: Place,
    ) => void;
    onClose: () => void;
}

const MIN_QUERY = 3;
const DEBOUNCE_MS = 300;
const LISTBOX_ID = 'location-results';

/** Full-screen place search: type, pick a result, return to the step. */
export default function LocationPage({ value, onSelect, onClose }: Props) {
    const [query, setQuery] = useState(value);
    const [results, setResults] = useState<GeocodeSuggestion[]>([]);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    const [active, setActive] = useState(-1);
    const seq = useRef(0);

    const trimmed = query.trim();
    const tooShort = trimmed.length < MIN_QUERY;

    useEffect(() => {
        if (tooShort) return;
        const id = ++seq.current;
        const controller = new AbortController();
        const timer = window.setTimeout(async () => {
            setLoading(true);
            setFailed(false);
            try {
                const found = await searchSuggestionAddress(trimmed, { kind: 'venue', signal: controller.signal });
                if (id !== seq.current) return; // superseded by a newer query
                setResults(found);
                setActive(-1);
            } catch {
                if (id !== seq.current) return;
                setResults([]);
                setFailed(true);
            } finally {
                if (id === seq.current) setLoading(false);
            }
        }, DEBOUNCE_MS);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [trimmed, tooShort]);

    // Results from a longer query are hidden rather than cleared, so deleting a
    // character and typing it again does not have to re-fetch.
    const visible = tooShort ? [] : results;
    const known = visible.filter((s) => s.source === 'known');
    const found = visible.filter((s) => s.source !== 'known');
    const ordered = [...known, ...found];

    const pick = (s: GeocodeSuggestion) => {
        onSelect(s.display_name, s.latitude, s.longitude, s.timezone ?? null, placeFromSuggestion(s));
        onClose();
    };

    const useAsTyped = () => {
        // The address may be a venue we can't geocode; let it through unverified.
        onSelect(query.trim(), null, null, null, NO_PLACE);
        onClose();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (!ordered.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % ordered.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i <= 0 ? ordered.length - 1 : i - 1));
        } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            pick(ordered[active]);
        } else if (e.key === 'Escape') {
            setActive(-1);
        }
    };

    // Keyboard selection lives on the combobox input (aria-activedescendant).
    const option = (s: GeocodeSuggestion, index: number) => (
        <li
            key={`${s.source}-${s.display_name}-${s.latitude}-${s.longitude}`}
            id={`${LISTBOX_ID}-${index}`}
            role="option"
            aria-selected={index === active}
            onClick={() => pick(s)}
            onMouseEnter={() => setActive(index)}
            className={`flex w-full cursor-pointer items-start gap-3 rounded-field border border-line px-4 py-3 text-left transition ${index === active ? 'bg-canvas' : 'bg-surface'}`}
        >
            {s.source === 'known' ? (
                <Star size={18} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden="true" />
            ) : (
                <MapPin size={18} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden="true" />
            )}
            <span className="min-w-0">
                <span className="block truncate text-sm text-ink">{s.name || s.display_name}</span>
                {s.context ? <span className="block truncate text-xs text-ink-soft">{s.context}</span> : null}
            </span>
        </li>
    );

    return (
        <SubPage title="Location" onBack={onClose}>
            <div className="relative">
                <Search
                    size={18}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                    aria-hidden="true"
                />
                <input
                    type="search"
                    autoFocus
                    role="combobox"
                    aria-label="Search for a place or address"
                    aria-autocomplete="list"
                    aria-expanded={ordered.length > 0}
                    aria-controls={LISTBOX_ID}
                    aria-activedescendant={active >= 0 ? `${LISTBOX_ID}-${active}` : undefined}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search for a place or address"
                    className={`${inputCls} pl-10`}
                />
            </div>

            {trimmed.length > 0 && tooShort ? <p className={helpCls}>Keep typing to search.</p> : null}
            {loading && !tooShort ? <p className={helpCls}>Searching…</p> : null}
            {failed && !tooShort ? <p className={helpCls}>Search is unavailable right now.</p> : null}

            <ul id={LISTBOX_ID} role="listbox" aria-label="Places" className="mt-3 space-y-2">
                {known.length > 0 ? (
                    <li role="presentation" className="pt-1 text-xs font-medium text-ink-soft">Known venues</li>
                ) : null}
                {known.map((s, i) => option(s, i))}
                {known.length > 0 && found.length > 0 ? (
                    <li role="presentation" className="pt-2 text-xs font-medium text-ink-soft">Places</li>
                ) : null}
                {found.map((s, i) => option(s, known.length + i))}
            </ul>
            <PlaceAttribution results={visible} />

            {!tooShort && !loading ? (
                <button
                    type="button"
                    onClick={useAsTyped}
                    className="mt-3 w-full rounded-field border border-line bg-surface px-4 py-3 text-left text-sm text-ink-soft transition hover:bg-canvas"
                >
                    Use “{trimmed}” as typed
                </button>
            ) : null}
        </SubPage>
    );
}
