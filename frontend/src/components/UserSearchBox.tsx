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
 * input alone routes to ``/tribe/discover?q=…`` so the user gets a richer page.
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
                setMobileExpanded(false);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, []);

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            setOpen(false);
            setMobileExpanded(false);
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
                navigate(`/tribe/discover?q=${encodeURIComponent(q.trim())}`);
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

    // Below lg, the icon opens a fixed panel beneath the header.
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
        role: 'combobox',
        'aria-expanded': open,
    };

    const term = q.trim();
    const showDropdown = open && (term.length === 0 || term.length >= 2);

    const renderDropdownContent = (idPrefix: string) => (
        <div id={`${idPrefix}-listbox`} role="listbox">
            {term.length === 0 && (
                <Link
                    to="/tribe/discover"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={reset}
                    className="block px-3 py-2 hover:bg-canvas"
                >
                    <div className="text-xs font-medium text-ink">Find people</div>
                    <div className="text-[11px] text-ink-soft">
                        Browse suggestions and curated calendars
                    </div>
                </Link>
            )}
            {loading && <div className="p-3 text-xs text-ink-soft">Searching…</div>}
            {!loading && term.length >= 2 && results.length === 0 && (
                <div className="p-3 text-xs text-ink-soft">No users match “{term}”.</div>
            )}
            {!loading && results.map((user, index) => (
                <UserRow
                    key={user.handle}
                    id={`${idPrefix}-option-${index}`}
                    user={user}
                    active={index === activeIdx}
                    onClick={reset}
                />
            ))}
            {!loading && results.length === 0 && (suggestionsLoading || suggestions.length > 0) && (
                <>
                    <div className="border-t border-card-line px-3 pb-1 pt-3">
                        <div className="text-[11px] font-semibold uppercase text-ink">Suggestions</div>
                    </div>
                    {suggestionsLoading ? (
                        <div className="p-3 text-xs text-ink-soft">Loading…</div>
                    ) : (
                        suggestions.map((user, index) => (
                            <UserRow
                                key={user.handle}
                                id={`${idPrefix}-option-${index}`}
                                user={user}
                                active={index === activeIdx}
                                onClick={reset}
                            />
                        ))
                    )}
                </>
            )}
            {term.length >= 2 && (
                <Link
                    to={`/tribe/discover?q=${encodeURIComponent(term)}`}
                    onClick={reset}
                    className="block border-t border-card-line px-3 py-2 text-xs text-action hover:bg-canvas"
                >
                    See more on Discover →
                </Link>
            )}
            {!loading && term.length >= 2 && results.length === 0 && (
                <Link
                    to="/invite"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={reset}
                    className="block border-t border-card-line px-3 py-2 text-xs text-action hover:bg-canvas"
                >
                    Can’t find them? Invite a friend →
                </Link>
            )}
        </div>
    );

    return (
        <div ref={containerRef} className="relative">
            <div className="hidden w-64 items-center gap-2 border border-line bg-canvas px-2 py-1 lg:flex">
                <img src="/find-user.png" alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />
                <input
                    {...inputCommonProps}
                    aria-controls="people-search-desktop-listbox"
                    aria-activedescendant={activeIdx >= 0 ? `people-search-desktop-option-${activeIdx}` : undefined}
                    className="min-w-0 flex-1 bg-transparent text-xs text-ink placeholder:text-muted focus:outline-none"
                />
            </div>

            {!mobileExpanded && (
                <button
                    type="button"
                    onClick={() => {
                        setMobileExpanded(true);
                        setOpen(true);
                    }}
                    aria-label="Search users"
                    title="Search users"
                    className="inline-flex h-11 w-11 items-center justify-center text-ink-soft transition hover:text-ink lg:hidden"
                >
                    <img
                        src="/find-user.png"
                        alt=""
                        aria-hidden="true"
                        className="h-6 w-6"
                    />
                </button>
            )}

            {mobileExpanded && (
                <div
                    className="fixed left-3 right-3 z-[8600] border border-line bg-surface shadow-lg lg:hidden"
                    style={{ top: 'calc(64px + env(safe-area-inset-top) + 6px)' }}
                >
                    <div className="flex items-center gap-2 border-b border-line p-2">
                        <div className="flex flex-1 items-center gap-2 border border-line bg-surface px-2 py-1.5">
                            <img src="/find-user.png" alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />
                            <input
                                {...inputCommonProps}
                                aria-controls="people-search-compact-listbox"
                                aria-activedescendant={activeIdx >= 0 ? `people-search-compact-option-${activeIdx}` : undefined}
                                ref={mobileInputRef}
                                className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={reset}
                            aria-label="Close people search"
                            className="inline-flex h-9 w-9 items-center justify-center text-ink-soft hover:text-ink"
                        >
                            <span aria-hidden="true">×</span>
                        </button>
                    </div>
                    {showDropdown && <div className="max-h-80 overflow-auto">{renderDropdownContent('people-search-compact')}</div>}
                </div>
            )}

            {showDropdown && (
                <div className="absolute right-0 z-[8600] mt-1 hidden max-h-80 w-64 overflow-auto border border-line bg-surface shadow-lg lg:block">
                    {renderDropdownContent('people-search-desktop')}
                </div>
            )}
        </div>
    );
}

function UserRow({
    id,
    user,
    active,
    onClick,
}: {
    id: string;
    user: UserSearchResult;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <Link
            id={id}
            role="option"
            aria-selected={active}
            to={`/u/${user.handle}`}
            onClick={onClick}
            className={
                'flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-canvas ' +
                (active ? 'bg-canvas' : '')
            }
        >
            <Avatar url={user.avatar_url} name={user.display_name || user.handle} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-ink truncate">
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
                <div className="text-[11px] text-ink-soft truncate">
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
        <div className="w-7 h-7 rounded-full bg-slate-200 text-ink-soft flex items-center justify-center text-xs font-semibold shrink-0">  {/* eslint-disable-line no-restricted-syntax -- avatar */}
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
