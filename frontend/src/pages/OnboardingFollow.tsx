/**
 * Phase E (E3) — onboarding follow screen.
 *
 * Shown once to every new user immediately after first sign-in via an
 * App-level guard that watches ``user.onboarded_at``. The screen
 * presents up to 10 "seed" accounts (verified organizers first, then
 * most-followed users) and offers two ways out:
 *   • Done   — POST batch follow + stamps ``onboarded_at``
 *   • Skip   — POST empty batch + still stamps ``onboarded_at``
 *
 * Either action terminates onboarding so the guard never bounces the
 * user here again. We refresh the auth user after the POST so
 * downstream consumers (NetworkPanel, friend_count) see the new state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
    completeOnboarding,
    fetchOnboardingSuggestions,
    searchUsers,
    type UserSearchResult,
} from '../api';
import { useAuth } from '../context/AuthContext';

/** Hard cap on how many seed suggestions we request from the backend.
 *  The endpoint accepts up to 25; we pick a middle value so the screen
 *  isn't an overwhelming wall of strangers but still gives enough choice
 *  to bootstrap a useful feed. */
const SUGGESTION_LIMIT = 12;

export default function OnboardingFollow() {
    const navigate = useNavigate();
    const [sp] = useSearchParams();
    const { refreshUser } = useAuth();
    const next = sp.get('next') || '/';

    const [items, setItems] = useState<UserSearchResult[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [submitting, setSubmitting] = useState(false);

    // Inline search for users not surfaced in the seed list. Picked
    // results are appended to ``items`` and pre-selected.
    const [search, setSearch] = useState('');
    const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const debouncedSearch = useDebounced(search, 250);

    useEffect(() => {
        let cancelled = false;
        fetchOnboardingSuggestions(SUGGESTION_LIMIT)
            .then((r) => {
                if (cancelled) return;
                setItems(r.items);
                setSelected(
                    new Set(r.items.map((it) => it.handle ?? '').filter(Boolean)),
                );
            })
            .catch((e: unknown) => {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : String(e));
                }
            });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const term = debouncedSearch.trim();
        if (term.length < 2) {
            setSearchResults([]);
            setSearching(false);
            return;
        }
        let cancelled = false;
        setSearching(true);
        searchUsers(term, { limit: 8 })
            .then((r) => { if (!cancelled) setSearchResults(r.items); })
            .catch(() => { if (!cancelled) setSearchResults([]); })
            .finally(() => { if (!cancelled) setSearching(false); });
        return () => { cancelled = true; };
    }, [debouncedSearch]);

    const toggle = useCallback((handle: string) => {
        setSelected((prev) => {
            const nextSet = new Set(prev);
            if (nextSet.has(handle)) nextSet.delete(handle);
            else nextSet.add(handle);
            return nextSet;
        });
    }, []);

    /** Add a search result to the list and mark it selected. */
    const addFromSearch = useCallback((u: UserSearchResult) => {
        const handle = u.handle;
        if (!handle) return;
        setItems((prev) => {
            const base = prev ?? [];
            if (base.some((it) => it.handle === handle)) return base;
            return [...base, u];
        });
        setSelected((prev) => {
            const nextSet = new Set(prev);
            nextSet.add(handle);
            return nextSet;
        });
        setSearch('');
        setSearchResults([]);
    }, []);

    const finish = useCallback(async (handles: string[]) => {
        setSubmitting(true);
        try {
            await completeOnboarding(handles);
            await refreshUser();
            window.dispatchEvent(new CustomEvent('network:changed'));
            navigate(next, { replace: true });
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }, [navigate, next, refreshUser]);

    const selectedCount = selected.size;
    const handlesArray = useMemo(() => Array.from(selected), [selected]);

    return (
        <div className="mx-auto max-w-2xl px-4 py-8">
            <div className="flex items-start justify-between mb-4">
                <div>
                    <h1 className="text-xl font-semibold text-slate-900">
                        Follow a few people to get started
                    </h1>
                    <p className="text-sm text-slate-600 mt-1">
                        Their events show up in your feed. You can always
                        change who you follow later.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void finish([])}
                    disabled={submitting}
                    aria-label="Skip onboarding"
                    className="text-sm text-slate-500 hover:text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Skip
                </button>
            </div>

            {error && (
                <div className="mb-3 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    {error}
                </div>
            )}

            {/* Inline search box so users can find specific accounts that
                aren't surfaced in the seed list (e.g. a friend who is
                neither verified nor most-followed). Adds the picked result
                to the list above as already-selected. */}
            <div className="mb-4">
                <label htmlFor="onboarding-user-search" className="sr-only">
                    Search for a specific person
                </label>
                <input
                    id="onboarding-user-search"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name or @handle"
                    aria-label="Search users"
                    className="w-full border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                />
                {search.trim().length >= 2 && (
                    <div className="mt-1 border border-slate-200 bg-white">
                        {searching && (
                            <p className="px-3 py-2 text-xs text-slate-500">Searching…</p>
                        )}
                        {!searching && searchResults.length === 0 && (
                            <p className="px-3 py-2 text-xs text-slate-500">No matches.</p>
                        )}
                        {searchResults.map((u) => {
                            const handle = u.handle ?? '';
                            const already = handle ? selected.has(handle) : false;
                            return (
                                <button
                                    key={handle || u.display_name}
                                    type="button"
                                    onClick={() => addFromSearch(u)}
                                    disabled={already}
                                    aria-label={already ? `Already added @${handle}` : `Add @${handle}`}
                                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {u.avatar_url ? (
                                        <img src={u.avatar_url} alt="" className="h-7 w-7 rounded-full object-cover" />
                                    ) : (
                                        <div className="h-7 w-7 rounded-full bg-slate-200" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs font-medium text-slate-800 truncate">
                                            {u.display_name || handle}
                                        </div>
                                        <div className="text-[11px] text-slate-500 truncate">@{handle}</div>
                                    </div>
                                    <span className="text-[11px] text-slate-500">
                                        {already ? 'Added' : 'Add'}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {items === null ? (
                <p className="text-sm text-slate-400">Loading suggestions…</p>
            ) : items.length === 0 ? (
                <p className="text-sm text-slate-500">
                    No suggestions yet — you can always discover people from the search bar.
                </p>
            ) : (
                <ul className="divide-y divide-slate-100 border border-slate-200 bg-white">
                    {items.map((u) => {
                        const handle = u.handle ?? '';
                        const isSelected = handle ? selected.has(handle) : false;
                        return (
                            <li key={handle || u.display_name}>
                                <button
                                    type="button"
                                    onClick={() => handle && toggle(handle)}
                                    aria-pressed={isSelected}
                                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
                                >
                                    {u.avatar_url ? (
                                        <img
                                            src={u.avatar_url}
                                            alt=""
                                            className="h-10 w-10 rounded-full object-cover"
                                        />
                                    ) : (
                                        <div className="h-10 w-10 rounded-full bg-slate-200" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1">
                                            <span className="text-sm font-medium text-slate-900 truncate">
                                                {u.display_name || handle}
                                            </span>
                                            {u.is_verified_organizer && (
                                                <img
                                                    src="/orga.png"
                                                    alt=""
                                                    title="Verified organizer"
                                                    aria-label="Verified organizer"
                                                    className="w-3.5 h-3.5 object-contain"
                                                />
                                            )}
                                            {u.is_admin_managed && (
                                                <img
                                                    src="/badge.png"
                                                    alt=""
                                                    title="Curator"
                                                    aria-label="Curator"
                                                    className="w-3.5 h-3.5 object-contain"
                                                />
                                            )}
                                        </div>
                                        <div className="text-xs text-slate-500 truncate">
                                            @{handle}
                                        </div>
                                    </div>
                                    <span
                                        className={
                                            'px-3 py-1 text-xs font-medium border ' +
                                            (isSelected
                                                ? 'bg-blue-500 border-blue-500 text-white'
                                                : 'border-slate-200 bg-white text-slate-700')
                                        }
                                    >
                                        {isSelected ? 'Following' : 'Follow'}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="mt-6 flex justify-end">
                <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void finish(handlesArray)}
                    className="bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {submitting
                        ? 'Saving…'
                        : selectedCount === 0
                            ? 'Done'
                            : `Follow ${selectedCount} and continue`}
                </button>
            </div>
        </div>
    );
}

/** Local debounce hook — kept here to avoid a one-off shared util. */
function useDebounced<T>(value: T, ms: number): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const id = setTimeout(() => setV(value), ms);
        return () => clearTimeout(id);
    }, [value, ms]);
    return v;
}
