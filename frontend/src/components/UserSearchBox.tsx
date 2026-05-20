import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { searchUsers, type UserSearchResult } from '../api';

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
    const [loading, setLoading] = useState(false);
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
            return;
        }
        let cancelled = false;
        setLoading(true);
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
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => Math.min(results.length - 1, i + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, i - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIdx >= 0 && results[activeIdx]) {
                navigate(`/u/${results[activeIdx].handle}`);
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
        onFocus: () => q.trim().length >= 2 && setOpen(true),
        onKeyDown,
        placeholder: 'Search people…',
        'aria-label': 'Search users',
    };

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
                    <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="w-4 h-4"
                        aria-hidden="true"
                    >
                        <path
                            fillRule="evenodd"
                            clipRule="evenodd"
                            d="M9 3a6 6 0 1 0 3.873 10.59l3.768 3.768a1 1 0 0 0 1.415-1.415l-3.769-3.768A6 6 0 0 0 9 3Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                        />
                    </svg>
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

            {open && (q.trim().length >= 2) && (
                <div className="absolute right-0 mt-1 w-64 max-w-[calc(100vw-1rem)] bg-white border border-slate-200 shadow-lg z-50 max-h-80 overflow-auto">
                    {loading && (
                        <div className="p-3 text-xs text-slate-500">Searching…</div>
                    )}
                    {!loading && results.length === 0 && (
                        <div className="p-3 text-xs text-slate-500">
                            No users match “{q.trim()}”.
                        </div>
                    )}
                    {!loading &&
                        results.map((u, i) => (
                            <Link
                                key={u.handle}
                                to={`/u/${u.handle}`}
                                onClick={reset}
                                className={
                                    'flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 ' +
                                    (i === activeIdx ? 'bg-slate-50' : '')
                                }
                            >
                                <Avatar url={u.avatar_url} name={u.display_name || u.handle} />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1 text-slate-900 truncate">
                                        <span className="truncate">
                                            {u.display_name || `@${u.handle}`}
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
                                    </div>
                                    <div className="text-[11px] text-slate-500 truncate">
                                        @{u.handle} · {u.subscribers_count} subscriber
                                        {u.subscribers_count === 1 ? '' : 's'}
                                    </div>
                                </div>
                            </Link>
                        ))}
                    <Link
                        to={`/discover?q=${encodeURIComponent(q.trim())}`}
                        onClick={reset}
                        className="block px-3 py-2 text-xs text-blue-600 hover:bg-slate-50 border-t border-slate-100"
                    >
                        See more on Discover →
                    </Link>
                </div>
            )}
        </div>
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
