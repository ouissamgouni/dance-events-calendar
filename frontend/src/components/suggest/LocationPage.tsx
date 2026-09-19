import { useEffect, useRef, useState } from 'react';
import { MapPin, Search } from 'lucide-react';
import SubPage from './SubPage';
import { searchSuggestionAddress, type GeocodeSuggestion } from '../../api';
import { helpCls, inputCls } from './formState';

interface Props {
    value: string;
    onSelect: (location: string, latitude: number | null, longitude: number | null) => void;
    onClose: () => void;
}

const MIN_QUERY = 3;
const DEBOUNCE_MS = 300;

/** Full-screen address search: type, pick a result, return to the step. */
export default function LocationPage({ value, onSelect, onClose }: Props) {
    const [query, setQuery] = useState(value);
    const [results, setResults] = useState<GeocodeSuggestion[]>([]);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    const seq = useRef(0);

    const trimmed = query.trim();
    const tooShort = trimmed.length < MIN_QUERY;

    useEffect(() => {
        if (tooShort) return;
        const id = ++seq.current;
        const timer = window.setTimeout(async () => {
            setLoading(true);
            setFailed(false);
            try {
                const found = await searchSuggestionAddress(trimmed);
                if (id !== seq.current) return; // superseded by a newer query
                setResults(found);
            } catch {
                if (id !== seq.current) return;
                setResults([]);
                setFailed(true);
            } finally {
                if (id === seq.current) setLoading(false);
            }
        }, DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [trimmed, tooShort]);

    // Results from a longer query are hidden rather than cleared, so deleting a
    // character and typing it again does not have to re-fetch.
    const visible = tooShort ? [] : results;

    const pick = (s: GeocodeSuggestion) => {
        onSelect(s.display_name, s.latitude, s.longitude);
        onClose();
    };

    const useAsTyped = () => {
        // The address may be a venue we can't geocode; let it through unverified.
        onSelect(query.trim(), null, null);
        onClose();
    };

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
                    aria-label="Search for a place or address"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search for a place or address"
                    className={`${inputCls} pl-10`}
                />
            </div>

            {trimmed.length > 0 && tooShort ? <p className={helpCls}>Keep typing to search.</p> : null}
            {loading && !tooShort ? <p className={helpCls}>Searching…</p> : null}
            {failed && !tooShort ? <p className={helpCls}>Search is unavailable right now.</p> : null}

            <ul className="mt-3 space-y-2">
                {visible.map((s) => (
                    <li key={`${s.display_name}-${s.latitude}-${s.longitude}`}>
                        <button
                            type="button"
                            onClick={() => pick(s)}
                            className="flex w-full items-start gap-3 rounded-field border border-line bg-surface px-4 py-3 text-left transition hover:bg-canvas"
                        >
                            <MapPin size={18} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden="true" />
                            <span className="min-w-0">
                                <span className="block truncate text-sm text-ink">
                                    {s.name || s.display_name}
                                </span>
                                {s.context ? (
                                    <span className="block truncate text-xs text-ink-soft">{s.context}</span>
                                ) : null}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>

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
