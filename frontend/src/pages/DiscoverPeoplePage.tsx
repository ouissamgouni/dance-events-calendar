import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ChevronLeft } from 'lucide-react';
import {
    dismissSuggestion,
    fetchMySuggestions,
    followUser,
    searchUsers,
    type FoFSuggestionItem,
    type UserSearchResult,
} from '../api';
import UserResultCard from '../components/UserResultCard';
import PeopleSearchResults from '../components/PeopleSearchResults';

const PAGE_SIZE = 20;

/** /people/discover — full list of "people you may know" behind the trails' "See more". */
export default function DiscoverPeoplePage() {
    const navigate = useNavigate();
    const [items, setItems] = useState<FoFSuggestionItem[] | null>(null);
    const [total, setTotal] = useState(0);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const loadedRef = useRef(0);
    const [params, setParams] = useSearchParams();
    const q = params.get('q') ?? '';
    const [searchInput, setSearchInput] = useState(q);
    const [results, setResults] = useState<UserSearchResult[] | null>(null);
    const [searching, setSearching] = useState(false);

    const setQuery = useCallback((value: string | null) => {
        setParams((prev) => {
            const next = new URLSearchParams(prev);
            if (value) next.set('q', value);
            else next.delete('q');
            return next;
        }, { replace: true });
    }, [setParams]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- sync URL param into the local input
        setSearchInput(q);
    }, [q]);

    useEffect(() => {
        const trimmed = searchInput.trim();
        if (trimmed === q) return;
        const t = setTimeout(() => setQuery(trimmed || null), 300);
        return () => clearTimeout(t);
    }, [searchInput, q, setQuery]);

    useEffect(() => {
        const term = q.trim();
        if (!term) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- short-circuit reset when search is cleared
            setResults(null);
            return;
        }
        let cancelled = false;
        setSearching(true);
        searchUsers(term, { limit: 25 })
            .then((res) => {
                if (!cancelled) setResults(res.items);
            })
            .catch(() => {
                if (!cancelled) setResults([]);
            })
            .finally(() => {
                if (!cancelled) setSearching(false);
            });
        return () => {
            cancelled = true;
        };
    }, [q]);

    const followFromSearch = async (handle: string) => {
        setPending(handle);
        try {
            await followUser(handle);
            setResults((prev) => prev?.map((r) => (r.handle === handle ? { ...r, is_followed_by_viewer: true } : r)) ?? prev);
            window.dispatchEvent(new CustomEvent('network:changed'));
        } finally {
            setPending(null);
        }
    };

    const reload = useCallback(() => {
        // Followed/dismissed people leave the server pool, so refetch the same span from 0.
        fetchMySuggestions({ limit: Math.max(PAGE_SIZE, Math.min(loadedRef.current, 50)) })
            .then((r) => {
                setItems(r.items);
                setTotal(r.total);
                loadedRef.current = r.items.length;
                setError(false);
            })
            .catch(() => setError(true));
    }, []);

    useEffect(() => {
        reload();
        window.addEventListener('network:changed', reload);
        return () => window.removeEventListener('network:changed', reload);
    }, [reload]);

    const loadMore = async () => {
        setLoadingMore(true);
        try {
            const r = await fetchMySuggestions({ limit: PAGE_SIZE, offset: loadedRef.current });
            setItems((prev) => {
                const seen = new Set(prev?.map((it) => it.handle));
                const next = [...(prev ?? []), ...r.items.filter((it) => !seen.has(it.handle))];
                loadedRef.current = next.length;
                return next;
            });
            setTotal(r.total);
        } catch {
            setError(true);
        } finally {
            setLoadingMore(false);
        }
    };

    const act = async (handle: string, action: (h: string) => Promise<unknown>) => {
        setPending(handle);
        try {
            await action(handle);
            setItems((prev) => prev?.filter((it) => it.handle !== handle) ?? prev);
            setTotal((t) => Math.max(0, t - 1));
            loadedRef.current = Math.max(0, loadedRef.current - 1);
            window.dispatchEvent(new CustomEvent('network:changed'));
        } finally {
            setPending(null);
        }
    };

    const handleBack = () => {
        if (window.history.length > 1) navigate(-1);
        else navigate('/tribe/network');
    };

    return (
        <div className="mx-auto max-w-3xl px-4 pt-2 pb-6">
            <Helmet>
                <title>Discover people</title>
            </Helmet>
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={handleBack}
                    aria-label="Back"
                    className="-ml-2 flex h-11 w-11 items-center justify-center text-ink-soft transition hover:bg-canvas hover:text-ink"
                >
                    <ChevronLeft size={22} aria-hidden="true" />
                </button>
                <h1 className="text-xl font-semibold text-ink">Discover people</h1>
            </div>
            <p className="mb-4 text-sm text-ink-soft">People you may know from your scene.</p>

            <div className="mb-5">
                <input
                    type="search"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search by name or handle…"
                    aria-label="Search by name or handle"
                    className="w-full border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                    style={{ height: 40 }}
                />
                <p className="mt-2 text-xs text-ink-soft">
                    Can’t find them?{' '}
                    <Link to="/invite" className="font-medium text-action hover:underline">
                        Invite a friend →
                    </Link>
                </p>
            </div>

            {q ? (
                <PeopleSearchResults
                    term={q}
                    loading={searching}
                    results={results}
                    pending={pending}
                    onFollow={(h) => void followFromSearch(h)}
                    onClear={() => setQuery(null)}
                />
            ) : items === null && !error ? (
                <p className="text-sm text-ink-soft">Loading…</p>
            ) : items === null || (error && items.length === 0) ? (
                <p className="py-8 text-center text-sm text-ink-soft">Couldn’t load suggestions.</p>
            ) : items.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-soft">No suggestions right now.</p>
            ) : (
                <>
                    <ul className="divide-y divide-line bg-surface" data-testid="discover-people-list">
                        {items.map((it) => {
                            const previewHead = it.mutual_friends_preview[0];
                            const previewRest = it.mutual_friend_count - (previewHead ? 1 : 0);
                            return (
                                <li key={it.handle}>
                                    <UserResultCard
                                        user={it}
                                        variant="rich"
                                        href={`/u/${it.handle}`}
                                        subtitle={previewHead
                                            ? <>Followed by @{previewHead}{previewRest > 0 && ` + ${previewRest} more`}</>
                                            : <>@{it.handle}</>}
                                        trailing={(
                                            <div className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        void act(it.handle, followUser);
                                                    }}
                                                    disabled={pending === it.handle}
                                                    aria-label={`Follow ${it.handle}`}
                                                    className="bg-action px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    {pending === it.handle ? '…' : 'Follow'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        void act(it.handle, dismissSuggestion);
                                                    }}
                                                    disabled={pending === it.handle}
                                                    aria-label={`Not interested in ${it.handle}`}
                                                    title="Not interested"
                                                    className="flex h-7 w-7 items-center justify-center text-xs text-muted hover:text-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        )}
                                    />
                                </li>
                            );
                        })}
                    </ul>
                    {total > items.length && (
                        <button
                            type="button"
                            onClick={() => void loadMore()}
                            disabled={loadingMore}
                            className="mt-4 w-full border border-line bg-surface py-2 text-sm font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {loadingMore ? 'Loading…' : 'Load more'}
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
