import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
    fetchSuggestedUsers,
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
 * 2. Suggested for you — friends-of-friends ranking from
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
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        setError(null);
        searchUsers(term, { limit: 25 })
            .then((res) => {
                if (!cancelled) setResults(res.items);
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : 'Search failed');
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
                <h1 className="text-xl font-semibold text-slate-900">Discover people</h1>
                <p className="text-sm text-slate-500 mt-1">
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
                    className="w-full text-sm border border-slate-200 px-3 py-2 focus:outline-none focus:border-blue-500"
                />
                <div className="mt-4">
                    {q.trim().length === 0 ? null : q.trim().length < 2 ? (
                        <p className="text-xs text-slate-500">
                            Type at least two characters to search.
                        </p>
                    ) : loading ? (
                        <p className="text-sm text-slate-500">Searching…</p>
                    ) : error ? (
                        <p className="text-sm text-red-600">{error}</p>
                    ) : !results || results.length === 0 ? (
                        <p className="text-sm text-slate-500">
                            No users match “{q.trim()}”.
                        </p>
                    ) : (
                        <UserGrid users={results} />
                    )}
                </div>
            </section>

            {user && <SuggestedSection />}
        </div>
    );
}

function SuggestedSection() {
    const [users, setUsers] = useState<UserSearchResult[] | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        fetchSuggestedUsers({ limit: 12 })
            .then((res) => {
                if (!cancelled) setUsers(res.items);
            })
            .catch(() => {
                if (!cancelled) setUsers([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Stay quiet on cold-start (no follows/subs yet) — empty hint already
    // communicated by the search box. The section header would be noise.
    if (!loading && (!users || users.length === 0)) return null;

    return (
        <section>
            <h2 className="text-base font-semibold text-slate-900 mb-2">
                Suggested for you
            </h2>
            <p className="text-xs text-slate-500 mb-3">
                People that those you follow are subscribed to.
            </p>
            {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
            ) : (
                <UserGrid users={users ?? []} />
            )}
        </section>
    );
}

function UserGrid({ users }: { users: UserSearchResult[] }) {
    return (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {users.map((u) => (
                <li
                    key={u.handle}
                    className="border border-slate-200 bg-white p-3 flex items-center gap-3"
                >
                    <Avatar url={u.avatar_url} name={u.display_name || u.handle} />
                    <div className="min-w-0 flex-1">
                        <Link
                            to={`/u/${u.handle}`}
                            className="block text-sm font-medium text-slate-900 hover:text-blue-600 truncate"
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
                        </Link>
                        <div className="text-xs text-slate-500 truncate">
                            @{u.handle} · {u.subscribers_count} subscriber
                            {u.subscribers_count === 1 ? '' : 's'}
                            {u.is_subscribed && (
                                <span className="ml-1 text-emerald-600">
                                    · subscribed
                                </span>
                            )}
                        </div>
                    </div>
                </li>
            ))}
        </ul>
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
        <div className="w-10 h-10 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-sm font-semibold shrink-0">  {/* eslint-disable-line no-restricted-syntax -- avatar */}
            {initial}
        </div>
    );
}
