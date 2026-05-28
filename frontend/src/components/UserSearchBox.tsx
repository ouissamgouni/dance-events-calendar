import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchCurators, searchUsers, type UserSearchResult } from '../api';

/**
 * Header user-search box (Phase D, D.5).
 *
 * Debounced 250ms autosuggest backed by ``GET /api/social/search/users``.
 * Hits the same backend rate limit (30/min/IP) — debounce + min-length 2
 * keep the typical typing burst well under that.
 *
 * Pressing Enter on a result navigates to the public profile; Enter on the
 * input alone routes to ``/discover?q=…`` so the user gets a richer page.
 */
export default function UserSearchBox() {
    const [q, setQ] = useState('');
    const [results, setResults] = useState<UserSearchResult[]>([]);
    const [suggestions, setSuggestions] = useState<UserSearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [suggestionsLoading, setSuggestionsLoading] = useState(false);
    const [open, setOpen] = useState(false);
    const [activeIdx, setActiveIdx] = useState(-1);
    const containerRef = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();

    const debounced = useDebounced(q, 250);

    useEffect(() => {
        const term = debounced.trim();
        if (term.length < 2) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- short-circuit reset for too-short input
            setResults([]);
            setLoading(false);
            setActiveIdx(-1);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setSuggestions([]);
        searchUsers(term, { limit: 8 })
            .then((res) => {
                if (cancelled) return;
                setResults(res.items);
                setActiveIdx(res.items.length > 0 ? 0 : -1);
            })
            .catch(() => {
                if (!cancelled) setResults([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [debounced]);

    useEffect(() => {
        const term = debounced.trim();
        const shouldFetch =
            open && term.length >= 2 && !loading && results.length === 0;
        if (!shouldFetch) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when suggestions are not part of the current dropdown state
            setSuggestions([]);
            setSuggestionsLoading(false);
            return;
        }
        let cancelled = false;
        setSuggestionsLoading(true);
        fetchCurators({ limit: 5 })
            .then((res) => {
                if (cancelled) return;
                setSuggestions(res.items);
                setActiveIdx(res.items.length > 0 ? 0 : -1);
            })
            .catch(() => {
                if (!cancelled) setSuggestions([]);
            })
            .finally(() => {
                if (!cancelled) setSuggestionsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [debounced, loading, open, results.length]);

    // Click-outside closes the dropdown without clearing input.
    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, []);

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
            return;
        }
        // Mobile UX: backspace on an empty input collapses the inline box.
        if (e.key === 'Backspace' && q === '' && mobileExpanded) {
            e.preventDefault();
            setMobileExpanded(false);
            return;
        }
        if (!open) return;
        const menuRows = results.length > 0 ? results : suggestions;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => Math.min(menuRows.length - 1, i + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, i - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIdx >= 0 && menuRows[activeIdx]) {
                navigate(`/u/${menuRows[activeIdx].handle}`);
                reset();
            } else if (q.trim()) {
                navigate(`/discover?q=${encodeURIComponent(q.trim())}`);
                reset();
            }
        }
    };

    const reset = () => {
        setOpen(false);
        setQ('');
        setResults([]);
        setSuggestions([]);
        setMobileExpanded(false);
    };

    // Mobile-only: collapsed to a magnifier icon by default; tap to expand
    // into a small inline input that replaces the icon (header logo stays
    // visible on the left).
    const [mobileExpanded, setMobileExpanded] = useState(false);
    const mobileInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (mobileExpanded) mobileInputRef.current?.focus();
    }, [mobileExpanded]);

    const inputCommonProps = {
        type: 'search' as const,
        value: q,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            setQ(e.target.value);
            setOpen(true);
        },
        onFocus: () => setOpen(true),
        onKeyDown,
        placeholder: 'Search people…',
        'aria-label': 'Search users',
    };

    const term = q.trim();
    const showDropdown = open && (term.length === 0 || term.length >= 2);

    return (
        <div ref={containerRef} className="relative">
            {/* Mobile: icon trigger (hidden when expanded) */}
            {!mobileExpanded && (
                <button
                    type="button"
                    onClick={() => setMobileExpanded(true)}
                    aria-label="Search users"
                    title="Search users"
                    className="sm:hidden inline-flex items-center justify-center w-7 h-7 text-white hover:text-gray-200 transition"
                >
                    <img
                        src="/find-user.png"
                        alt=""
                        aria-hidden="true"
                        className="h-4 w-4 invert"
                    />
                </button>
            )}

            {/* Desktop: inline input */}
            <input
                {...inputCommonProps}
                className="hidden sm:block w-48 text-xs px-2 py-1 bg-gray-700 text-white placeholder:text-gray-400 border border-gray-600 focus:outline-none focus:border-blue-400"
            />

            {/* Mobile expanded: small inline input replacing the icon */}
            {mobileExpanded && (
                <div className="sm:hidden inline-flex items-center gap-1">
                    <input
                        {...inputCommonProps}
                        ref={mobileInputRef}
                        onBlur={() => {
                            // Auto-collapse if user taps away with no query.
                            if (q === '') setMobileExpanded(false);
                        }}
                        className="w-32 text-xs px-2 py-1 bg-gray-700 text-white placeholder:text-gray-400 border border-gray-600 focus:outline-none focus:border-blue-400"
                    />
                    <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={reset}
                        aria-label="Close search"
                        title="Close search"
                        className="inline-flex items-center justify-center w-6 h-6 text-white hover:text-gray-200 transition"
                    >
                        <svg
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            className="w-4 h-4"
                            aria-hidden="true"
                        >
                            <path
                                fillRule="evenodd"
                                clipRule="evenodd"
                                d="M4.293 4.293a1 1 0 0 1 1.414 0L10 8.586l4.293-4.293a1 1 0 1 1 1.414 1.414L11.414 10l4.293 4.293a1 1 0 0 1-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 0 1-1.414-1.414L8.586 10 4.293 5.707a1 1 0 0 1 0-1.414Z"
                            />
                        </svg>
                    </button>
                </div>
            )}

            {showDropdown && (
                <div className="absolute right-0 mt-1 w-64 max-w-[calc(100vw-1rem)] bg-white border border-slate-200 shadow-lg z-50 max-h-80 overflow-auto">
                    {term.length === 0 && (
                        <Link
                            to="/discover"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={reset}
                            className="block px-3 py-2 hover:bg-slate-50"
                        >
                            <div className="text-xs font-medium text-slate-900">
                                Find people
                            </div>
                            <div className="text-[11px] text-slate-500">
                                Browse suggestions and curated calendars
                            </div>
                        </Link>
                    )}
                    {loading && (
                        <div className="p-3 text-xs text-slate-500">Searching…</div>
                    )}
                    {!loading && term.length >= 2 && results.length === 0 && (
                        <div className="p-3 text-xs text-slate-500">
                            No users match “{term}”.
                        </div>
                    )}
                    {!loading &&
                        results.map((u, i) => (
                            <UserRow key={u.handle} user={u} active={i === activeIdx} onClick={reset} />
                        ))}
                    {!loading && results.length === 0 && (suggestionsLoading || suggestions.length > 0) && (
                        <>
                            <div className="px-3 pt-3 pb-1 border-t border-slate-100">
                                <div className="text-[11px] font-semibold text-slate-700 uppercase">
                                    Suggestions
                                </div>
                            </div>
                            {suggestionsLoading ? (
                                <div className="p-3 text-xs text-slate-500">Loading…</div>
                            ) : (
                                suggestions.map((u, i) => (
                                    <UserRow
                                        key={u.handle}
                                        user={u}
                                        active={i === activeIdx}
                                        onClick={reset}
                                    />
                                ))
                            )}
                        </>
                    )}
                    {term.length >= 2 && (
                        <Link
                            to={`/discover?q=${encodeURIComponent(term)}`}
                            onClick={reset}
                            className="block px-3 py-2 text-xs text-blue-600 hover:bg-slate-50 border-t border-slate-100"
                        >
                            See more on Discover →
                        </Link>
                    )}
                </div>
            )}
        </div>
    );
}

function UserRow({
    user,
    active,
    onClick,
}: {
    user: UserSearchResult;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <Link
            to={`/u/${user.handle}`}
            onClick={onClick}
            className={
                'flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-slate-50 ' +
                (active ? 'bg-slate-50' : '')
            }
        >
            <Avatar url={user.avatar_url} name={user.display_name || user.handle} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-slate-900 truncate">
                    <span className="truncate">
                        {user.display_name || `@${user.handle}`}
                    </span>
                    {user.is_verified_organizer && (
                        <img
                            src="/orga.png"
                            alt=""
                            title="Verified organizer"
                            aria-label="Verified organizer"
                            className="w-3.5 h-3.5 object-contain"
                        />
                    )}
                    {user.is_admin_managed && (
                        <img
                            src="/badge.png"
                            alt=""
                            title="Curator"
                            aria-label="Curator"
                            className="w-3.5 h-3.5 object-contain"
                        />
                    )}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                    @{user.handle} · {user.subscribers_count} subscriber
                    {user.subscribers_count === 1 ? '' : 's'}
                </div>
            </div>
        </Link>
    );
}

function Avatar({ url, name }: { url: string | null; name: string }) {
    if (url) {
        return (
            <img
                src={url}
                alt=""
                className="w-7 h-7 rounded-full object-cover bg-slate-100 shrink-0"  // eslint-disable-line no-restricted-syntax -- avatar (allowed exception per ui-conventions)
            />
        );
    }
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    return (
        <div className="w-7 h-7 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-xs font-semibold shrink-0">  {/* eslint-disable-line no-restricted-syntax -- avatar */}
            {initial}
        </div>
    );
}

function useDebounced<T>(value: T, ms: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const id = window.setTimeout(() => setDebounced(value), ms);
        return () => window.clearTimeout(id);
    }, [value, ms]);
    return debounced;
}
