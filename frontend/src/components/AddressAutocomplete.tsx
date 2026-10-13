import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { GeocodeSuggestion, PlaceSearchOptions } from '../api';
import { searchAddress } from '../api';
import PlaceAttribution from './PlaceAttribution';

interface Props {
    value: string;
    onChange: (value: string) => void;
    onSelect: (suggestion: GeocodeSuggestion) => void;
    searchFn?: (query: string, options?: PlaceSearchOptions) => Promise<GeocodeSuggestion[]>;
}

const LISTBOX_ID = 'address-autocomplete-results';

export default function AddressAutocomplete({ value, onChange, onSelect, searchFn }: Props) {
    const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [active, setActive] = useState(-1);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const abortRef = useRef<AbortController | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const doFetch = searchFn ?? searchAddress;

    const doSearch = useCallback(async (q: string) => {
        abortRef.current?.abort();
        if (q.length < 3) {
            setSuggestions([]);
            return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
        try {
            const results = await doFetch(q, { kind: 'venue', signal: controller.signal });
            setSuggestions(results);
            setActive(-1);
            setOpen(results.length > 0);
        } catch {
            if (!controller.signal.aborted) setSuggestions([]);
        } finally {
            if (abortRef.current === controller) setLoading(false);
        }
    }, [doFetch]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        onChange(v);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => doSearch(v), 300);
    };

    const handleSelect = (s: GeocodeSuggestion) => {
        onChange(s.display_name);
        onSelect(s);
        setOpen(false);
        setSuggestions([]);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (!open || suggestions.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % suggestions.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            handleSelect(suggestions[active]);
        } else if (e.key === 'Escape') {
            setOpen(false);
        }
    };

    // Close on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const expanded = open && suggestions.length > 0;

    return (
        <div ref={containerRef} className="relative">
            <input
                type="text"
                role="combobox"
                aria-label="Location"
                aria-autocomplete="list"
                aria-expanded={expanded}
                aria-controls={LISTBOX_ID}
                aria-activedescendant={expanded && active >= 0 ? `${LISTBOX_ID}-${active}` : undefined}
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onFocus={() => suggestions.length > 0 && setOpen(true)}
                placeholder="Search a venue or address…"
                className="w-full rounded-field border border-line px-3 py-2 text-sm placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
            />
            {loading && (
                <span className="absolute right-2 top-2.5 text-xs text-ink-soft">…</span>
            )}
            {expanded && (
                <div className="absolute z-50 mt-1 w-full rounded-field border border-line bg-surface px-1 pb-1 shadow-lg">
                    <ul id={LISTBOX_ID} role="listbox" aria-label="Places" className="max-h-56 overflow-auto">
                        {suggestions.map((s, i) => (
                            <li
                                key={`${s.source}-${s.display_name}-${s.latitude}-${s.longitude}`}
                                id={`${LISTBOX_ID}-${i}`}
                                role="option"
                                aria-selected={i === active}
                                onClick={() => handleSelect(s)}
                                onMouseEnter={() => setActive(i)}
                                className={`cursor-pointer px-3 py-2 text-sm ${i === active ? 'bg-canvas' : ''}`}
                            >
                                <span className="block truncate text-ink">
                                    {s.source === 'known' ? <span className="mr-1 text-xs text-ink-soft">Known ·</span> : null}
                                    {s.name || s.display_name}
                                </span>
                                {s.context ? <span className="block truncate text-xs text-ink-soft">{s.context}</span> : null}
                            </li>
                        ))}
                    </ul>
                    <PlaceAttribution results={suggestions} />
                </div>
            )}
        </div>
    );
}
