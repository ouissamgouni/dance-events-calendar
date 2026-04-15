import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeocodeSuggestion } from '../api';
import { searchAddress } from '../api';

interface Props {
    value: string;
    onChange: (value: string) => void;
    onSelect: (suggestion: GeocodeSuggestion) => void;
    searchFn?: (query: string) => Promise<GeocodeSuggestion[]>;
}

export default function AddressAutocomplete({ value, onChange, onSelect, searchFn }: Props) {
    const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout>>();
    const containerRef = useRef<HTMLDivElement>(null);
    const doFetch = searchFn ?? searchAddress;

    const doSearch = useCallback(async (q: string) => {
        if (q.length < 3) {
            setSuggestions([]);
            return;
        }
        setLoading(true);
        try {
            const results = await doFetch(q);
            setSuggestions(results);
            setOpen(results.length > 0);
        } catch {
            setSuggestions([]);
        } finally {
            setLoading(false);
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

    return (
        <div ref={containerRef} className="relative">
            <input
                type="text"
                value={value}
                onChange={handleChange}
                onFocus={() => suggestions.length > 0 && setOpen(true)}
                placeholder="Type an address…"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {loading && (
                <span className="absolute right-2 top-2.5 text-xs text-slate-400">…</span>
            )}
            {open && suggestions.length > 0 && (
                <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
                    {suggestions.map((s, i) => (
                        <li
                            key={i}
                            onClick={() => handleSelect(s)}
                            className="cursor-pointer px-3 py-2 text-sm text-slate-700 hover:bg-blue-50"
                        >
                            {s.display_name}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
