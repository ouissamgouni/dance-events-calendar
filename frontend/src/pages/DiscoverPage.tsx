import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
    fetchCurators,
    fetchSuggestedUsers,
    followUser,
    searchUsers,
    type UserSearchResult,
} from '../api';

/**
 * /discover (Phase D, D.5).
 *
 * Two surfaces in one page:
 * 1. Search — controlled input synced to ``?q=…`` so links from the header
 *    search box land in a stable, shareable URL. 25-result cap matches the
 *    backend's ``limit`` ceiling.
 * 2. Suggestions — friends-of-friends ranking with curator fallback from
 *    ``GET /social/discover/suggested``. Hidden for anon viewers (the
 *    endpoint returns an empty list anyway).
 *
 * No "saved searches" or filters yet — keep the page lean. Browse-by-tag
 * lives elsewhere; this page is exclusively about people.
 */
export default function DiscoverPage() {
    const { user } = useAuth();
    const [params, setParams] = useSearchParams();
    const initialQ = params.get('q') ?? '';
    const [q, setQ] = useState(initialQ);
    const [results, setResults] = useState<UserSearchResult[] | null>(null);
    const [curatorResults, setCuratorResults] = useState<UserSearchResult[]>([]);
    const [curatorsLoading, setCuratorsLoading] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const trimmedQ = q.trim();

    // Sync ``q`` -> URL so reloads / back nav preserve the search.
    useEffect(() => {
        const trimmed = q.trim();
        const current = params.get('q') ?? '';
        if (trimmed === current) return;
        const next = new URLSearchParams(params);
        if (trimmed) next.set('q', trimmed);
        else next.delete('q');
        setParams(next, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q]);

    // Fetch results whenever the URL ``q`` changes (covers external nav).
    useEffect(() => {
        const term = (params.get('q') ?? '').trim();
        if (term.length < 2) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- short-input reset, no async work to schedule
            setResults(null);
            setCuratorResults([]);
            setCuratorsLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        searchUsers(term, { limit: 25 })
            .then(async (res) => {
                if (cancelled) return;
                setResults(res.items);
                if (res.items.length === 0) {
                    setCuratorsLoading(true);
                    try {
                        const curators = await fetchCurators({ limit: 12 });
                        if (!cancelled) setCuratorResults(curators.items);
                    } finally {
                        if (!cancelled) setCuratorsLoading(false);
                    }
                } else {
                    setCuratorResults([]);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : 'Search failed');
                    setCuratorResults([]);
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [params]);

    return (
        <div className="max-w-3xl mx-auto p-6 space-y-8">
            <div>
                <h1 className="text-xl font-semibold text-ink">Discover people</h1>
                <p className="text-sm text-ink-soft mt-1">
                    Find dancers, organizers, and venues to follow.
                </p>
            </div>

            <section>
                <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search by name or handle…"
                    autoFocus
                    className="w-full text-sm border border-line px-3 py-2 focus:outline-none focus:border-action"
                />
                <p className="mt-2 text-xs text-ink-soft">
                    Can’t find them?{' '}
                    <Link
                        to="/invite"
                        className="font-semibold text-action hover:text-action"
                    >
                        Invite a friend →
                    </Link>
                </p>
                <div className="mt-4">
                    {trimmedQ.length === 0 ? null : trimmedQ.length < 2 ? (
                        <p className="text-xs text-ink-soft">
                            Type at least two characters to search.
                        </p>
                    ) : loading ? (
                        <p className="text-sm text-ink-soft">Searching…</p>
                    ) : error ? (
                        <p className="text-sm text-danger">{error}</p>
                    ) : !results || results.length === 0 ? (
                        <div className="space-y-3">
                            <p className="text-sm text-ink-soft">
                                No users match “{trimmedQ}”.
                            </p>
                            {(curatorsLoading || curatorResults.length > 0) && (
                                <section>
                                    <h2 className="text-xs font-semibold text-ink uppercase mb-2">
                                        Suggestions
                                    </h2>
                                    {curatorsLoading ? (
                                        <p className="text-sm text-ink-soft">Loading…</p>
                                    ) : (
                                        <UserGrid users={curatorResults} />
                                    )}
                                </section>
                            )}
                        </div>
                    ) : (
                        <UserGrid users={results} />
                    )}
                </div>
            </section>

            {!user && <AnonDiscoverHint />}
            {user && trimmedQ.length === 0 && <DefaultDiscoverSections />}
        </div>
    );
}

function AnonDiscoverHint() {
    return (
        <section className="border border-line bg-canvas p-3 flex items-center justify-between gap-3">
            <p className="text-sm text-ink-soft">
                Sign in to see more people from your network.
            </p>
            <Link
                to="/login"
                className="bg-action text-white hover:bg-action px-3 py-1 text-xs font-semibold"
            >
                Sign in
            </Link>
        </section>
    );
}

function DefaultDiscoverSections() {
    const PAGE = 12;
    const [suggestedUsers, setSuggestedUsers] = useState<UserSearchResult[] | null>(null);
    const [total, setTotal] = useState(0);
    const [viewStart, setViewStart] = useState(0);
    const [loadedEnd, setLoadedEnd] = useState(0);
    const [pendingFollow, setPendingFollow] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetchSuggestedUsers({ limit: PAGE })
            .then((suggested) => {
                if (cancelled) return;
                setSuggestedUsers(suggested.items);
                setTotal(suggested.total);
                setViewStart(0);
                setLoadedEnd(suggested.items.length);
            })
            .catch(() => {
                if (!cancelled) setSuggestedUsers([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    async function handleFollow(handle: string) {
        setPendingFollow(handle);
        try {
            await followUser(handle);
            setSuggestedUsers((prev) =>
                prev ? prev.filter((u) => u.handle !== handle) : prev,
            );
            window.dispatchEvent(new CustomEvent('network:changed'));
        } finally {
            setPendingFollow(null);
        }
    }

    // Rotate the window to the next page, wrapping to the start once the pool
    // is exhausted, so repeat clicks keep surfacing different people.
    async function handleShuffle() {
        const nextStart = viewStart + PAGE >= total ? 0 : viewStart + PAGE;
        setBusy(true);
        try {
            const r = await fetchSuggestedUsers({ limit: PAGE, offset: nextStart });
            setSuggestedUsers(r.items);
            setTotal(r.total);
            setViewStart(nextStart);
            setLoadedEnd(nextStart + r.items.length);
        } finally {
            setBusy(false);
        }
    }

    async function handleShowMore() {
        setBusy(true);
        try {
            const r = await fetchSuggestedUsers({ limit: PAGE, offset: loadedEnd });
            setSuggestedUsers((prev) => [...(prev ?? []), ...r.items]);
            setTotal(r.total);
            setLoadedEnd((e) => e + r.items.length);
        } finally {
            setBusy(false);
        }
    }

    const suggestions = suggestedUsers ?? [];

    if (loading) {
        return <p className="text-sm text-ink-soft">Loading suggestions…</p>;
    }

    if (suggestions.length === 0) {
        return (
            <section className="border border-line bg-canvas p-3">
                <p className="text-sm text-ink-soft">
                    Search by name or handle, or check the suggested people if any.
                </p>

            </section>
        );
    }

    const canShuffle = total > PAGE;
    const canShowMore = loadedEnd < total;

    return (
        <div className="space-y-6">
            <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-base font-semibold text-ink">
                        Suggestions
                    </h2>
                    {canShuffle && (
                        <button
                            type="button"
                            onClick={() => void handleShuffle()}
                            disabled={busy}
                            className="text-xs font-semibold text-action hover:text-action disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Shuffle
                        </button>
                    )}
                </div>
                <p className="text-xs text-ink-soft mb-3">
                    People followed by your network and curated accounts you may want to follow.
                </p>
                <UserGrid
                    users={suggestions}
                    onFollow={(handle) => void handleFollow(handle)}
                    pendingFollow={pendingFollow}
                />
                {canShowMore && (
                    <button
                        type="button"
                        onClick={() => void handleShowMore()}
                        disabled={busy}
                        className="mt-4 w-full border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {busy ? 'Loading…' : 'Show more'}
                    </button>
                )}
            </section>
        </div>
    );
}

type DiscoverUser = UserSearchResult;

function UserGrid({
    users,
    onFollow,
    pendingFollow,
}: {
    users: DiscoverUser[];
    onFollow?: (handle: string) => void;
    pendingFollow?: string | null;
}) {
    return (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {users.map((u) => (
                <li
                    key={u.handle}
                    className="border border-line bg-surface p-3 flex items-center gap-3"
                >
                    <Avatar url={u.avatar_url} name={u.display_name || u.handle} />
                    <div className="min-w-0 flex-1">
                        <Link
                            to={`/u/${u.handle}`}
                            className="block text-sm font-medium text-ink hover:text-action truncate"
                        >
                            {u.display_name || `@${u.handle}`}
                            {u.is_verified_organizer && (
                                <img
                                    src="/orga.png"
                                    alt=""
                                    title="Verified organizer"
                                    aria-label="Verified organizer"
                                    className="inline-block w-3.5 h-3.5 ml-1 align-middle object-contain"
                                />
                            )}
                            {u.is_admin_managed && (
                                <img
                                    src="/badge.png"
                                    alt=""
                                    title="Curator"
                                    aria-label="Curator"
                                    className="inline-block w-3.5 h-3.5 ml-1 align-middle object-contain"
                                />
                            )}
                        </Link>
                        <UserMeta user={u} />
                    </div>
                    {onFollow && !u.is_followed_by_viewer && (
                        <button
                            type="button"
                            onClick={() => onFollow(u.handle)}
                            disabled={pendingFollow === u.handle}
                            aria-label={`Follow ${u.handle}`}
                            className="bg-action px-3 py-1 text-xs font-medium text-white hover:bg-action disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                        >
                            {pendingFollow === u.handle ? '…' : 'Follow'}
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}

function UserMeta({ user }: { user: DiscoverUser }) {
    const previewHead = user.mutual_friends_preview?.[0];
    const previewRest = (user.mutual_friend_count ?? 0) - (previewHead ? 1 : 0);
    return (
        <div className="min-w-0">
            {previewHead && (
                <div className="text-xs text-ink-soft truncate">
                    Followed by @{previewHead}
                    {previewRest > 0 && ` + ${previewRest} more`}
                </div>
            )}
            <div className="text-xs text-ink-soft truncate">
                @{user.handle} · {user.subscribers_count} subscriber
                {user.subscribers_count === 1 ? '' : 's'}
                {user.is_subscribed && (
                    <span className="ml-1 text-success">
                        · subscribed
                    </span>
                )}
            </div>
        </div>
    );
}

function Avatar({ url, name }: { url: string | null; name: string }) {
    if (url) {
        return (
            <img
                src={url}
                alt=""
                className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0"  // eslint-disable-line no-restricted-syntax -- avatar (allowed exception)
            />
        );
    }
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    return (
        <div className="w-10 h-10 rounded-full bg-slate-200 text-ink-soft flex items-center justify-center text-sm font-semibold shrink-0">  {/* eslint-disable-line no-restricted-syntax -- avatar */}
            {initial}
        </div>
    );
}
