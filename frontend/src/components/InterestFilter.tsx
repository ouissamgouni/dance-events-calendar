import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchMyFollowing, fetchInterestSummary } from '../api';
import type { FollowUser, InterestSummaryItem } from '../api';
import { firstNameOf } from '../utils/displayName';

export interface InterestFilterChange {
    source?: 'follows' | 'friends' | null;
    kind?: 'any' | 'going' | 'saved';
    userHandles?: string[];
    match?: 'any' | 'all';
}

/**
 * Horizontally-scrollable trail of followees/friends matching the active
 * scope + kind, each rendered as an avatar + name + matched-event-count
 * checkbox so the viewer can multi-select specific people to narrow the
 * feed to. ``any`` sums going+saved (best-effort — a person who both
 * attends and saved the same event is counted twice; acceptable for this
 * lightweight display count). People with zero matching events are omitted.
 */
export function FollowingPersonRail({
    scope,
    kind,
    selectedHandles,
    onToggle,
}: {
    scope: 'follows' | 'friends';
    kind: 'any' | 'going' | 'saved';
    selectedHandles: string[];
    onToggle: (handle: string) => void;
}) {
    const [rows, setRows] = useState<FollowUser[]>([]);
    const [metrics, setMetrics] = useState<Map<string, InterestSummaryItem>>(new Map());
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchMyFollowing({ limit: 100 })
            .then((res) => {
                if (cancelled) return null;
                const items = scope === 'friends' ? res.items.filter((u) => u.is_friend) : res.items;
                setRows(items);
                return fetchInterestSummary(items.map((u) => u.handle));
            })
            .then((items) => {
                if (cancelled || !items) return;
                const m = new Map<string, InterestSummaryItem>();
                for (const it of items) m.set(it.handle, it);
                setMetrics(m);
            })
            .catch(() => {
                if (!cancelled) {
                    setRows([]);
                    setMetrics(new Map());
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [scope]);

    // Up to five pills: selected people first (so the collapsed row doubles
    // as the applied-filter summary), then the highest-count candidates for
    // quick inline discovery. Candidates with zero matching events are
    // omitted, but a selected person always stays visible.
    const visible = useMemo(() => {
        const countFor = (handle: string) => {
            const m = metrics.get(handle);
            if (!m) return 0;
            if (kind === 'going') return m.upcoming_going_visible;
            if (kind === 'saved') return m.upcoming_saved_visible;
            return m.upcoming_going_visible + m.upcoming_saved_visible;
        };
        const selected = rows.filter((u) => selectedHandles.includes(u.handle));
        const others = rows
            .filter((u) => !selectedHandles.includes(u.handle) && countFor(u.handle) > 0)
            .sort((a, b) => countFor(b.handle) - countFor(a.handle));
        return [...selected, ...others].slice(0, 5).map((user) => ({ user, count: countFor(user.handle) }));
    }, [rows, metrics, kind, selectedHandles]);

    if (loading && visible.length === 0) return null;
    if (visible.length === 0) return null;

    return (
        <div
            className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5 sm:gap-2"
            data-testid="following-person-rail"
        >
            {visible.map(({ user, count }, i) => {
                const checked = selectedHandles.includes(user.handle);
                const label = firstNameOf(user.display_name, user.handle);
                // Show 3 pills on mobile, 5 on desktop.
                const hideOnMobile = i >= 3 ? ' max-sm:hidden' : '';
                return (
                    <button
                        type="button"
                        key={user.handle}
                        onClick={() => onToggle(user.handle)}
                        aria-pressed={checked}
                        aria-label={`Toggle ${label}`}
                        className={
                            'inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border px-2 py-1 text-xs transition ' +
                            (checked
                                ? 'bg-blue-400 border-blue-400 text-white'
                                : 'bg-surface border-line text-ink-soft hover:border-action hover:text-action') +
                            hideOnMobile
                        }
                    >
                        {user.avatar_url ? (
                            <img
                                src={user.avatar_url}
                                alt=""
                                className="h-4 w-4 shrink-0 rounded-full object-cover"
                                loading="lazy"
                            />
                        ) : (
                            <span
                                className={
                                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ' +
                                    (checked ? 'bg-surface/25 text-white' : 'bg-slate-200 text-ink-soft')
                                }
                            >
                                {label.replace(/^@/, '').slice(0, 1).toUpperCase()}
                            </span>
                        )}
                        <span className="max-w-[7rem] truncate">{label}</span>
                        <span className={checked ? 'text-white/80' : 'text-muted'}>({count})</span>
                    </button>
                );
            })}
        </div>
    );
}


/**
 * Searchable list of everyone the viewer follows (scope-aware), rendered
 * inside the popover overlay. Each row = avatar + full name + matched-event
 * count and toggles selection on click (no checkbox). People with zero
 * matching events are still listed so anyone can be found; the list scrolls
 * once it exceeds five rows.
 */
export function FollowingPersonSearch({
    scope,
    kind,
    selectedHandles,
    onToggle,
}: {
    scope: 'follows' | 'friends';
    kind: 'any' | 'going' | 'saved';
    selectedHandles: string[];
    onToggle: (handle: string) => void;
}) {
    const [rows, setRows] = useState<FollowUser[]>([]);
    const [metrics, setMetrics] = useState<Map<string, InterestSummaryItem>>(new Map());
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchMyFollowing({ limit: 100 })
            .then((res) => {
                if (cancelled) return null;
                const items = scope === 'friends' ? res.items.filter((u) => u.is_friend) : res.items;
                setRows(items);
                return fetchInterestSummary(items.map((u) => u.handle));
            })
            .then((items) => {
                if (cancelled || !items) return;
                const m = new Map<string, InterestSummaryItem>();
                for (const it of items) m.set(it.handle, it);
                setMetrics(m);
            })
            .catch(() => {
                if (!cancelled) {
                    setRows([]);
                    setMetrics(new Map());
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [scope]);

    const filtered = useMemo(() => {
        const countFor = (handle: string) => {
            const m = metrics.get(handle);
            if (!m) return 0;
            if (kind === 'going') return m.upcoming_going_visible;
            if (kind === 'saved') return m.upcoming_saved_visible;
            return m.upcoming_going_visible + m.upcoming_saved_visible;
        };
        const q = query.trim().toLowerCase();
        return rows
            .filter((u) => {
                if (!q) return true;
                return (u.display_name || '').toLowerCase().includes(q) || u.handle.toLowerCase().includes(q);
            })
            .map((user) => ({ user, count: countFor(user.handle) }))
            .sort((a, b) => b.count - a.count);
    }, [rows, metrics, kind, query]);

    return (
        <div className="w-full" data-testid="following-person-search">
            <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people you follow…"
                aria-label="Search people you follow"
                className="w-full border border-line px-2 py-1 pr-7 text-xs text-ink placeholder:text-muted focus:border-action focus:outline-none"
            />
            {/* max-h caps the list at ~5 rows; the rest scrolls. */}
            <div className="mt-2 flex max-h-48 flex-col overflow-y-auto">
                {loading ? (
                    <p className="px-1 py-2 text-xs text-muted">Loading…</p>
                ) : filtered.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted">No people found.</p>
                ) : (
                    filtered.map(({ user, count }) => {
                        const checked = selectedHandles.includes(user.handle);
                        const label = user.display_name || `@${user.handle}`;
                        return (
                            <button
                                type="button"
                                key={user.handle}
                                onClick={() => onToggle(user.handle)}
                                aria-pressed={checked}
                                aria-label={`Toggle ${label}`}
                                className={
                                    'flex items-center gap-2 px-1 py-1.5 text-left text-xs transition ' +
                                    (checked ? 'bg-blue-50 text-action' : 'text-ink hover:bg-canvas')
                                }
                            >
                                {user.avatar_url ? (
                                    <img
                                        src={user.avatar_url}
                                        alt=""
                                        className="h-5 w-5 shrink-0 rounded-full object-cover"
                                        loading="lazy"
                                    />
                                ) : (
                                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-ink-soft">
                                        {label.replace(/^@/, '').slice(0, 1).toUpperCase()}
                                    </span>
                                )}
                                <span className="min-w-0 flex-1 truncate">{label}</span>
                                {checked && (
                                    <svg
                                        aria-hidden="true"
                                        viewBox="0 0 20 20"
                                        className="h-3.5 w-3.5 shrink-0 text-action"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M4 10.5l4 4 8-8" />
                                    </svg>
                                )}
                                <span className="shrink-0 text-[11px] text-muted">({count})</span>
                            </button>
                        );
                    })
                )}
            </div>
        </div>
    );
}


export function InterestFilterChips({
    signedIn,
    followingCount,
    interestSource,
    interestKind,
    interestUserHandles,
    interestMatch,
    onChange,
    showShortcut = true,
}: {
    signedIn: boolean;
    followingCount?: number;
    interestSource: 'follows' | 'friends' | null;
    interestKind: 'any' | 'going' | 'saved';
    interestUserHandles: string[];
    interestMatch: 'any' | 'all';
    onChange: (next: InterestFilterChange) => void;
    showShortcut?: boolean;
}) {
    // Anonymous users see the inline "Sign in to…" hint when they click
    // the Following pill (rather than the pill being disabled and the
    // hint only showing in the post-logout edge case where
    // interestSource had been left non-null).
    const [showAnonHint, setShowAnonHint] = useState(false);
    const [overlayOpen, setOverlayOpen] = useState(false);
    // Draft people edited inside the overlay; committed only on Anyone/
    // Everyone, discarded on Close (outside click / Escape). Scope + kind
    // apply live from the inline toggles, so they are not drafted here.
    const [draftHandles, setDraftHandles] = useState<string[]>(interestUserHandles);

    // Filter is only actually applied once the viewer has explicitly
    // picked a scope or at least one person — nothing is on by default.
    const filterActive = interestSource !== null || interestUserHandles.length > 0;

    useEffect(() => {
        if (!overlayOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOverlayOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [overlayOpen]);

    // Nobody to filter by yet — swap the pills for a nudge toward
    // building a network instead of showing controls with no effect.
    if (signedIn && followingCount === 0) {
        return (
            <div
                className="flex flex-wrap items-center gap-1.5 text-xs text-ink-soft sm:gap-2"
                data-testid="following-filter-empty"
            >
                <span className="inline-flex shrink-0 items-center gap-1">
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 20 20"
                        className="h-3.5 w-3.5 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <circle cx="7" cy="7" r="3" />
                        <path d="M2 17c0-2.8 2.2-5 5-5s5 2.2 5 5" />
                        <circle cx="14" cy="6" r="2.4" />
                        <path d="M13 12c2.8 0 5 2 5 5" />
                    </svg>
                    <span className="hidden sm:inline">Filter by following</span>
                </span>
                <span>You're not following anyone yet.</span>
                <Link to="/tribe/discover" className="text-action hover:underline">
                    Build your tribe →
                </Link>
            </div>
        );
    }

    // The search "+" button opens the overlay (anon viewers get the hint).
    const openOverlay = () => {
        if (!signedIn) {
            setShowAnonHint((v) => !v);
            return;
        }
        setDraftHandles(interestUserHandles);
        setOverlayOpen(true);
    };

    const closeOverlay = () => setOverlayOpen(false);

    // Anyone -> match any (OR); Everyone -> match all (AND). Both apply the
    // draft selection and collapse the overlay.
    const commitOverlay = (match: 'any' | 'all') => {
        onChange({
            source: draftHandles.length ? (interestSource ?? 'follows') : interestSource,
            userHandles: draftHandles,
            match,
        });
        setOverlayOpen(false);
    };

    const handleClear = () => {
        onChange({ source: null, kind: 'any', userHandles: [], match: 'any' });
    };

    // Inline rail quick-pick applies immediately; the operator stays whatever
    // is applied (default "any").
    const handleTogglePerson = (handle: string) => {
        const next = interestUserHandles.includes(handle)
            ? interestUserHandles.filter((h) => h !== handle)
            : [...interestUserHandles, handle];
        onChange({ userHandles: next });
    };

    // Overlay drafts only the people selection; a CTA commits it.
    const toggleDraftPerson = (handle: string) => {
        setDraftHandles((prev) =>
            prev.includes(handle) ? prev.filter((h) => h !== handle) : [...prev, handle],
        );
    };

    // Inline scope + kind toggles apply live (no overlay round-trip).
    // Switching scope resets people + kind, mirroring the pre-overlay UX.
    const applyScope = (scope: 'follows' | 'friends') => {
        onChange({ source: interestSource === scope ? null : scope, kind: 'any', userHandles: [] });
    };
    const goingOn = interestKind !== 'saved';
    const savedOn = interestKind !== 'going';
    const toggleKind = (which: 'going' | 'saved') => {
        const nextGoing = which === 'going' ? !goingOn : goingOn;
        const nextSaved = which === 'saved' ? !savedOn : savedOn;
        if (!nextGoing && !nextSaved) return;
        onChange({ kind: nextGoing && nextSaved ? 'any' : nextGoing ? 'going' : 'saved' });
    };

    // Quick shortcut to the dedicated "From people I follow" calendar view.
    // Hidden on surfaces that already are that calendar (via showShortcut).
    const shortcutLink = showShortcut && (
        <Link
            to={signedIn ? '/tribe/calendars' : `/login?next=${encodeURIComponent('/tribe/calendars')}`}
            data-testid="follows-shortcut"
            aria-label="Open the calendar from people I follow"
            title="Open the calendar from people I follow"
            className="hidden sm:inline-flex items-center px-2 py-1 text-xs border border-line bg-surface text-ink-soft hover:border-action hover:text-action transition"
        >
            {/* Heroicons calendar outline */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-3.5 h-3.5" aria-hidden="true">
                <rect x="2.75" y="4.25" width="14.5" height="13" rx="0" />
                <path d="M2.75 8.25h14.5M6.5 2.75v3M13.5 2.75v3" strokeLinecap="round" />
            </svg>
        </Link>
    );

    const anonHint = !signedIn && showAnonHint && (
        <span className="text-xs text-ink-soft">
            <Link to="/login" className="text-action hover:underline">
                Sign in
            </Link>{' '}
            to see picks from people you follow.
        </span>
    );

    // Collapsed pill rail: selected people (summary) + top candidates for
    // quick inline discovery, first-name only, no checkbox.
    const personRail = signedIn && (
        <FollowingPersonRail
            scope={interestSource ?? 'follows'}
            kind={interestKind}
            selectedHandles={interestUserHandles}
            onToggle={handleTogglePerson}
        />
    );

    // Inline scope toggle (All = everyone you follow, Friends = mutuals).
    const scopeToggle = signedIn && (
        <div
            className="inline-flex shrink-0 border border-line bg-surface"
            role="group"
            aria-label="Scope"
            data-testid="interest-scope-toggle"
        >
            {(['follows', 'friends'] as const).map((scope) => (
                <button
                    key={scope}
                    type="button"
                    onClick={() => applyScope(scope)}
                    aria-pressed={interestSource === scope}
                    className={
                        'px-2 py-1 text-xs transition ' +
                        (interestSource === scope ? 'bg-blue-400 text-white' : 'text-ink-soft hover:text-action')
                    }
                    title={scope === 'follows' ? 'Everyone you follow (one-way OK)' : 'Mutual followers only'}
                >
                    {scope === 'follows' ? 'All' : 'Friends'}
                </button>
            ))}
        </div>
    );

    // Inline kind toggle (Going / Saved; at least one always stays on).
    const kindToggle = signedIn && (
        <div
            className="inline-flex shrink-0 border border-line bg-surface"
            role="group"
            aria-label="Activity type"
            data-testid="interest-kind-toggle"
        >
            {([['going', goingOn], ['saved', savedOn]] as const).map(([k, on]) => (
                <button
                    key={k}
                    type="button"
                    onClick={() => toggleKind(k)}
                    aria-pressed={on}
                    className={
                        'px-2 py-1 text-xs transition ' +
                        (on ? 'bg-blue-400 text-white' : 'text-ink-soft hover:text-action')
                    }
                    title={k === 'going' ? 'Going activity' : 'Saved activity'}
                >
                    {k === 'going' ? 'Going' : 'Saved'}
                </button>
            ))}
        </div>
    );

    // Search "+" button — sits after the people pills (before the Any|All
    // operator) and opens the combo-box overlay.
    const searchButton = (
        <button
            type="button"
            onClick={openOverlay}
            aria-haspopup="dialog"
            aria-expanded={overlayOpen}
            aria-label="Search people to filter by"
            title="Search people to filter by"
            data-testid="following-search-open"
            className={
                'inline-flex shrink-0 items-center gap-0.5 border px-1.5 py-1 transition ' +
                (overlayOpen ? 'border-action bg-blue-50' : 'border-line bg-surface hover:border-action')
            }
        >
            <img src="/find-user.png" alt="" className="h-4 w-4" />
            <span className="text-xs font-semibold leading-none text-ink-soft">+</span>
        </button>
    );

    // any | all operator, shown in the collapsed summary only when 2+ people
    // are selected (the operator is meaningless for a single person).
    const matchSelector = signedIn && interestUserHandles.length > 1 && (
        <div
            className="inline-flex shrink-0 border border-line bg-surface"
            role="group"
            aria-label="Match any or all of the selected people"
            data-testid="interest-match-selector"
        >
            {(['any', 'all'] as const).map((op) => (
                <button
                    key={op}
                    type="button"
                    onClick={() => onChange({ match: op })}
                    aria-pressed={interestMatch === op}
                    className={
                        'px-1.5 py-0.5 text-[11px] transition sm:px-2 sm:py-1 sm:text-xs ' +
                        (interestMatch === op ? 'bg-blue-400 text-white' : 'text-ink-soft hover:text-action')
                    }
                    title={op === 'any' ? 'Match any selected person (or)' : 'Match all selected people (and)'}
                >
                    {op === 'any' ? 'Any' : 'All'}
                </button>
            ))}
        </div>
    );

    // Combo-box overlay: searchable people list + Close / Anyone / Everyone
    // CTAs. The people selection is a draft until a CTA commits it.
    const overlay = signedIn && overlayOpen && (
        <>
            <div className="fixed inset-0 z-20" onClick={closeOverlay} aria-hidden="true" />
            <div
                className="absolute left-0 bottom-full z-30 mb-1 w-72 max-w-[calc(100vw-2rem)] border border-line bg-surface p-2 shadow-lg"
                role="dialog"
                aria-label="Filter by people you follow"
                data-testid="following-person-overlay"
            >
                <button
                    type="button"
                    onClick={closeOverlay}
                    aria-label="Close"
                    className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center text-muted hover:text-ink"
                >
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 20 20"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M5 5l10 10M15 5L5 15" />
                    </svg>
                </button>
                <FollowingPersonSearch
                    scope={interestSource ?? 'follows'}
                    kind={interestKind}
                    selectedHandles={draftHandles}
                    onToggle={toggleDraftPerson}
                />
                <div className="mt-2 flex items-center justify-between gap-1.5">
                    <Link
                        to="/tribe/discover"
                        className="shrink-0 text-xs font-medium text-action hover:text-action"
                    >
                        Discover people
                    </Link>
                    <div className="flex items-center gap-1.5">
                        {draftHandles.length === 1 ? (
                            <button
                                type="button"
                                onClick={() => commitOverlay('any')}
                                className="border border-action bg-action px-2 py-1 text-xs text-white hover:bg-action"
                                title="Apply the selected person"
                                data-testid="following-apply"
                            >
                                Apply
                            </button>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={() => commitOverlay('all')}
                                    className="border border-line bg-surface px-2 py-1 text-xs text-ink hover:border-action hover:text-action"
                                    title="Match all of the selected people (and)"
                                    data-testid="following-apply-everyone"
                                >
                                    Everyone
                                </button>
                                <button
                                    type="button"
                                    onClick={() => commitOverlay('any')}
                                    className="border border-action bg-action px-2 py-1 text-xs text-white hover:bg-action"
                                    title="Match any of the selected people (or)"
                                    data-testid="following-apply-anyone"
                                >
                                    Anyone
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </>
    );

    // The search "+" button is the entry point on both surfaces (desktop
    // inline + mobile filter sheet). Nothing is selected by default; the
    // filter only applies once the viewer quick-picks a rail pill or
    // commits a selection from the overlay.
    return (
        <div className="relative flex flex-wrap items-center gap-1 sm:gap-2">
            <span className="inline-flex shrink-0 items-center gap-1 text-ink-soft">
                <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    className="h-3.5 w-3.5 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="7" cy="7" r="3" />
                    <path d="M2 17c0-2.8 2.2-5 5-5s5 2.2 5 5" />
                    <circle cx="14" cy="6" r="2.4" />
                    <path d="M13 12c2.8 0 5 2 5 5" />
                </svg>
            </span>
            {scopeToggle}
            {kindToggle}
            {personRail}
            {searchButton}
            {matchSelector}
            {filterActive && (
                <button
                    type="button"
                    onClick={handleClear}
                    className="inline-flex shrink-0 items-center px-2 py-0.5 text-xs text-ink-soft hover:text-action sm:py-1"
                    aria-label="Clear the following filter"
                    title="Clear the following filter"
                >
                    ✕
                </button>
            )}
            {shortcutLink}
            {anonHint}
            {overlay}
        </div>
    );
}
