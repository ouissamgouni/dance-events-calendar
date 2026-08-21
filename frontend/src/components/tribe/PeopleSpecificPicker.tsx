/**
 * "Select people" screen for the People filter's Specific-people mode.
 *
 * A full-screen overlay (Back / Select people / Done) with a search box, a
 * SELECTED (n) chip stack, and a multi-select list. Empty query lists the
 * viewer's followees (`fetchMyFollowing`); typing falls back to global user
 * search (`searchUsers`) so anyone can be picked. Selection is a draft —
 * committed to the filter only on Done, discarded on Back.
 */
import { useEffect, useMemo, useState } from 'react';
import {
    fetchMyFollowing,
    searchUsers,
    type FollowUser,
    type UserSearchResult,
} from '../../api';

interface Person {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_friend?: boolean;
}

function fromFollow(u: FollowUser): Person {
    return { handle: u.handle, display_name: u.display_name, avatar_url: u.avatar_url, is_friend: u.is_friend };
}
function fromSearch(u: UserSearchResult): Person {
    return { handle: u.handle, display_name: u.display_name, avatar_url: u.avatar_url, is_friend: u.is_friend };
}

function Avatar({ url, name, size = 8 }: { url: string | null; name: string; size?: 6 | 8 }) {
    const cls = size === 6 ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs';
    if (url) {
        return <img src={url} alt="" className={`${cls} shrink-0 rounded-full object-cover`} loading="lazy" />;
    }
    return (
        <span className={`${cls} inline-flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-ink-soft`}>
            {name.replace(/^@/, '').slice(0, 1).toUpperCase()}
        </span>
    );
}

export default function PeopleSpecificPicker({
    initialSelected,
    onDone,
    onBack,
}: {
    initialSelected: string[];
    onDone: (handles: string[]) => void;
    onBack: () => void;
}) {
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    const [followees, setFollowees] = useState<Person[]>([]);
    const [results, setResults] = useState<Person[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<string[]>(initialSelected);
    // Cache of handle → Person so selected chips render even after the row
    // scrolls out of the current result set.
    const [known, setKnown] = useState<Map<string, Person>>(new Map());

    useEffect(() => {
        const t = setTimeout(() => setDebounced(query.trim()), 250);
        return () => clearTimeout(t);
    }, [query]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchMyFollowing({ limit: 100 })
            .then((res) => {
                if (cancelled) return;
                const people = res.items.map(fromFollow);
                setFollowees(people);
                setKnown((prev) => {
                    const next = new Map(prev);
                    for (const p of people) next.set(p.handle, p);
                    return next;
                });
            })
            .catch(() => {
                if (!cancelled) setFollowees([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (debounced.length < 2) {
            setResults([]);
            return;
        }
        let cancelled = false;
        searchUsers(debounced, { limit: 20 })
            .then((res) => {
                if (cancelled) return;
                const people = res.items.map(fromSearch);
                setResults(people);
                setKnown((prev) => {
                    const next = new Map(prev);
                    for (const p of people) next.set(p.handle, p);
                    return next;
                });
            })
            .catch(() => {
                if (!cancelled) setResults([]);
            });
        return () => {
            cancelled = true;
        };
    }, [debounced]);

    const toggle = (handle: string) => {
        setSelected((prev) => (prev.includes(handle) ? prev.filter((h) => h !== handle) : [...prev, handle]));
    };

    const searching = debounced.length >= 2;
    const list = searching ? results : followees;

    const selectedPeople = useMemo(
        () => selected.map((h) => known.get(h)).filter((p): p is Person => !!p),
        [selected, known],
    );

    const labelFor = (p: Person) => p.display_name || `@${p.handle}`;

    return (
        <div className="flex h-full flex-col" data-testid="specific-people-picker">
            <div className="flex items-center justify-between border-b border-line px-2 py-2">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink"
                    aria-label="Back"
                >
                    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 4l-6 6 6 6" />
                    </svg>
                    Back
                </button>
                <span className="text-sm font-semibold text-ink">Select people</span>
                <button
                    type="button"
                    onClick={() => onDone(selected)}
                    className="text-sm font-semibold text-action hover:opacity-80"
                    data-testid="specific-people-done"
                >
                    Done
                </button>
            </div>

            <div className="border-b border-line px-3 py-2">
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name or handle…"
                    aria-label="Search by name or handle"
                    className="w-full border border-line px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none"
                />
            </div>

            {selectedPeople.length > 0 && (
                <div className="border-b border-line px-3 py-2">
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                        Selected ({selectedPeople.length})
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                        {selectedPeople.map((p) => (
                            <button
                                type="button"
                                key={p.handle}
                                onClick={() => toggle(p.handle)}
                                className="inline-flex items-center gap-1.5 border border-blue-200 bg-blue-50 py-0.5 pl-0.5 pr-2 text-xs text-action"
                                aria-label={`Remove ${labelFor(p)}`}
                            >
                                <Avatar url={p.avatar_url} name={labelFor(p)} size={6} />
                                <span className="max-w-[8rem] truncate">{labelFor(p)}</span>
                                <span aria-hidden="true">×</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-y-auto">
                {loading && !searching ? (
                    <p className="px-3 py-4 text-sm text-ink-soft">Loading…</p>
                ) : list.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-ink-soft">
                        {searching ? `No people match “${debounced}”.` : "You're not following anyone yet."}
                    </p>
                ) : (
                    <ul className="divide-y divide-line">
                        {list.map((p) => {
                            const checked = selected.includes(p.handle);
                            const label = labelFor(p);
                            return (
                                <li key={p.handle}>
                                    <button
                                        type="button"
                                        onClick={() => toggle(p.handle)}
                                        aria-pressed={checked}
                                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-canvas"
                                    >
                                        <Avatar url={p.avatar_url} name={label} />
                                        <div className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-medium text-ink">{label}</span>
                                            <span className="block truncate text-xs text-ink-soft">
                                                @{p.handle}
                                                {p.is_friend && ' · Friend'}
                                            </span>
                                        </div>
                                        <span
                                            aria-hidden="true"
                                            className={
                                                'inline-flex h-5 w-5 shrink-0 items-center justify-center border ' +
                                                (checked ? 'border-action bg-action text-white' : 'border-line bg-surface')
                                            }
                                        >
                                            {checked && (
                                                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M4 10.5l4 4 8-8" />
                                                </svg>
                                            )}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
