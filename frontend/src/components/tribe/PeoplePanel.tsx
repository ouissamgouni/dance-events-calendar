/**
 * Unified in-sheet People surface for the explorer's People filter.
 *
 * One component drives three entry points (see PeopleFilterPanel):
 *   - empty-network acquisition ("Build your tribe", inline, discover-only),
 *   - the tribe avatar-stack landing (overlay, `mode="build"`, tabs),
 *   - the Specific-people picker (overlay, `mode="select"`, tabs).
 *
 * Layout: an optional [My network | Discover] tab switcher, a search box
 * whose scope follows the active tab (network = local filter over followees,
 * discover = global `searchUsers`), a scrollable list of `UserResultCard`
 * rows, and (discover) friend-of-friend suggestions + an invite button that
 * opens in a new overlay.
 *
 *   - build mode: rows in Discover carry a Follow pill; Network rows are
 *     read-only ("Following").
 *   - select mode: every row is selectable; following a not-yet-followed
 *     person from Discover both follows AND selects them in one tap.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    fetchMyFollowing,
    fetchMySuggestions,
    followUser,
    searchUsers,
    type FollowUser,
    type FoFSuggestionItem,
    type UserSearchResult,
} from '../../api';
import UserResultCard, { type UserCardModel } from '../UserResultCard';
import useBackToClose from '../../hooks/useBackToClose';
import { firstNameOf } from '../../utils/displayName';

type Mode = 'build' | 'select';
type Tab = 'network' | 'discover';

interface Row {
    card: UserCardModel;
    subtitle?: ReactNode;
}

function mutualSubtitle(head: string | undefined, rest: number): ReactNode {
    if (!head) return undefined;
    return (
        <>
            Followed by @{head}
            {rest > 0 && ` + ${rest} others`}
        </>
    );
}

function followToRow(u: FollowUser): Row {
    return {
        card: {
            handle: u.handle,
            display_name: u.display_name,
            avatar_url: u.avatar_url,
            is_verified_organizer: u.is_verified_organizer,
            is_friend: u.is_friend,
            is_followed_by_viewer: true,
        },
    };
}

function suggestionToRow(it: FoFSuggestionItem): Row {
    const head = it.mutual_friends_preview[0];
    return {
        card: {
            handle: it.handle,
            display_name: it.display_name,
            avatar_url: it.avatar_url,
            is_verified_organizer: it.is_verified_organizer,
            is_admin_managed: it.is_admin_managed,
        },
        subtitle: mutualSubtitle(head, it.mutual_friend_count - (head ? 1 : 0)),
    };
}

function searchToRow(u: UserSearchResult): Row {
    const head = u.mutual_friends_preview?.[0];
    return {
        card: {
            handle: u.handle,
            display_name: u.display_name,
            avatar_url: u.avatar_url,
            is_verified_organizer: u.is_verified_organizer,
            is_admin_managed: u.is_admin_managed,
            is_friend: u.is_friend,
            is_followed_by_viewer: u.is_followed_by_viewer,
        },
        subtitle: mutualSubtitle(head, head ? (u.mutual_friend_count ?? 1) - 1 : 0),
    };
}

const peopleIllustration = (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-12 w-12 text-action" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="18" r="7" />
        <path d="M6 40c0-6.6 5.4-12 12-12s12 5.4 12 12" />
        <circle cx="34" cy="16" r="5.5" />
        <path d="M32 28c5.5 0 10 4.5 10 10" />
    </svg>
);

function BackIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4l-6 6 6 6" />
        </svg>
    );
}

/** Shared header for the stacked People surfaces (picker, find, invite). */
export function OverlayHeader({ title, onBack, action }: { title: string; onBack?: () => void; action?: ReactNode }) {
    return (
        <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line bg-surface px-1">
            <button
                type="button"
                onClick={onBack}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-ink transition-colors hover:text-action active:opacity-60"
                aria-label="Back"
            >
                <BackIcon />
            </button>
            <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{title}</h3>
            {action}
        </div>
    );
}

function CheckCircle({ checked }: { checked: boolean }) {
    return (
        <span
            aria-hidden="true"
            className={
                // eslint-disable-next-line no-restricted-syntax -- circular selection indicator (mobile list convention)
                'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ' +
                (checked ? 'border-action bg-action text-white' : 'border-line bg-surface')
            }
        >
            {checked && (
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 10.5l4 4 8-8" />
                </svg>
            )}
        </span>
    );
}

function SkeletonRows() {
    return (
        <div aria-busy="true">
            <span className="sr-only">Loading…</span>
            {[0, 1, 2].map((i) => (
                <div key={i} className="flex min-h-14 items-center gap-3 px-4 py-2.5 motion-safe:animate-pulse">
                    {/* eslint-disable-next-line no-restricted-syntax -- avatar placeholder */}
                    <span className="h-10 w-10 shrink-0 rounded-full bg-line" />
                    <span className="flex flex-1 flex-col gap-1.5">
                        <span className="h-3 w-1/2 rounded-field bg-line" />
                        <span className="h-2.5 w-1/3 rounded-field bg-line" />
                    </span>
                </div>
            ))}
        </div>
    );
}

export interface PeoplePanelProps {
    mode: Mode;
    /** 'inline' = empty-network primary state; 'overlay' = stacked surface. */
    variant: 'inline' | 'overlay';
    /** Handles followed within this sheet session (optimistic row state). */
    followedHandles: Set<string>;
    onFollowed: (handle: string, displayName: string) => void;
    /** select mode — current selection + toggling. */
    selected?: string[];
    onToggleSelect?: (handle: string) => void;
    /** Commits the surface (select: selected handles; build: closes). */
    onDone?: (handles: string[]) => void;
    /** Overlay back affordance (discards select drafts). */
    onBack?: () => void;
    /** Inline empty-state fallback: closes the whole filter sheet. */
    onExploreAll?: () => void;
    /** Open the invite sheet surface in a new overlay. */
    onOpenInvite?: () => void;
}

export default function PeoplePanel({
    mode,
    variant,
    followedHandles,
    onFollowed,
    selected = [],
    onToggleSelect,
    onDone,
    onBack,
    onExploreAll,
    onOpenInvite,
}: PeoplePanelProps) {
    const showTabs = variant === 'overlay';
    const [tab, setTab] = useState<Tab>(showTabs ? 'network' : 'discover');

    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    // The sticky CTA yields to the on-screen keyboard while searching.
    const [searchFocused, setSearchFocused] = useState(false);

    useBackToClose(onBack ?? (() => undefined), variant === 'overlay' && !!onBack);

    const [followees, setFollowees] = useState<Row[]>([]);
    const [loadingFollowees, setLoadingFollowees] = useState(true);
    const [suggestions, setSuggestions] = useState<Row[] | null>(null);
    const [loadingSuggestions, setLoadingSuggestions] = useState(false);
    const [results, setResults] = useState<Row[]>([]);
    const [shuffleSeed, setShuffleSeed] = useState(0);
    // handle → display name, so selected chips render after rows scroll away.
    const [known, setKnown] = useState<Map<string, Row>>(new Map());

    const remember = useCallback((rows: Row[]) => {
        setKnown((prev) => {
            const next = new Map(prev);
            for (const r of rows) next.set(r.card.handle, r);
            return next;
        });
    }, []);

    useEffect(() => {
        const t = setTimeout(() => setDebounced(query.trim()), 250);
        return () => clearTimeout(t);
    }, [query]);

    // Followees drive the Network tab + selected chips.
    useEffect(() => {
        let cancelled = false;
        setLoadingFollowees(true);
        fetchMyFollowing({ limit: 100 })
            .then((res) => {
                if (cancelled) return;
                const rows = res.items.map(followToRow);
                setFollowees(rows);
                remember(rows);
            })
            .catch(() => {
                if (!cancelled) setFollowees([]);
            })
            .finally(() => {
                if (!cancelled) setLoadingFollowees(false);
            });
        return () => {
            cancelled = true;
        };
    }, [remember]);

    // Suggestions load lazily the first time Discover is shown, and on Shuffle.
    useEffect(() => {
        if (tab !== 'discover') return;
        if (suggestions !== null && shuffleSeed === 0) return;
        let cancelled = false;
        setLoadingSuggestions(true);
        fetchMySuggestions({ limit: 20 })
            .then((res) => {
                if (cancelled) return;
                const rows = res.items.map(suggestionToRow);
                setSuggestions(rows);
                remember(rows);
            })
            .catch(() => {
                if (!cancelled) setSuggestions([]);
            })
            .finally(() => {
                if (!cancelled) setLoadingSuggestions(false);
            });
        return () => {
            cancelled = true;
        };
    }, [tab, shuffleSeed, suggestions, remember]);

    // Global user search — only on the Discover tab.
    useEffect(() => {
        if (tab !== 'discover' || debounced.length < 2) {
            setResults([]);
            return;
        }
        let cancelled = false;
        searchUsers(debounced, { limit: 20 })
            .then((res) => {
                if (cancelled) return;
                const rows = res.items.map(searchToRow);
                setResults(rows);
                remember(rows);
            })
            .catch(() => {
                if (!cancelled) setResults([]);
            });
        return () => {
            cancelled = true;
        };
    }, [tab, debounced, remember]);

    const isFollowed = useCallback(
        (r: Row) =>
            followedHandles.has(r.card.handle) ||
            r.card.is_followed_by_viewer === true ||
            r.card.is_friend === true,
        [followedHandles],
    );

    const doFollow = useCallback(
        async (r: Row) => {
            if (isFollowed(r)) return;
            const name = r.card.display_name || `@${r.card.handle}`;
            onFollowed(r.card.handle, name);
            try {
                await followUser(r.card.handle);
                window.dispatchEvent(new Event('network:changed'));
            } catch {
                // Optimistic UI already flipped; rolls back on next refresh.
            }
        },
        [isFollowed, onFollowed],
    );

    const activate = useCallback(
        (r: Row) => {
            if (mode !== 'select') return;
            if (!isFollowed(r)) void doFollow(r);
            onToggleSelect?.(r.card.handle);
        },
        [mode, isFollowed, doFollow, onToggleSelect],
    );

    const orderedSuggestions = useMemo(() => {
        if (!suggestions) return null;
        if (shuffleSeed === 0) return suggestions;
        return [...suggestions].sort(() => Math.random() - 0.5);
    }, [suggestions, shuffleSeed]);

    const selectedRows = useMemo(
        () => selected.map((h) => known.get(h)).filter((r): r is Row => !!r),
        [selected, known],
    );

    const searching = tab === 'discover' && debounced.length >= 2;

    const networkList = useMemo(() => {
        const q = debounced.toLowerCase();
        if (!q) return followees;
        return followees.filter((r) => {
            const name = (r.card.display_name || '').toLowerCase();
            return name.includes(q) || r.card.handle.toLowerCase().includes(q);
        });
    }, [followees, debounced]);

    const renderRow = (r: Row) => {
        const followed = isFollowed(r);
        let trailing: ReactNode;
        if (mode === 'select') {
            trailing = <CheckCircle checked={selected.includes(r.card.handle)} />;
        } else if (tab === 'network') {
            trailing = null;
        } else {
            trailing = (
                <button
                    type="button"
                    onClick={() => void doFollow(r)}
                    disabled={followed}
                    aria-label={followed ? `Following ${r.card.handle}` : `Follow ${r.card.handle}`}
                    aria-pressed={followed}
                    className={
                        'inline-flex min-h-9 shrink-0 items-center rounded-field px-4 text-sm font-semibold transition ' +
                        (followed
                            ? 'bg-canvas text-ink-soft'
                            : 'bg-action text-white hover:opacity-90 active:opacity-80')
                    }
                >
                    {followed ? 'Following' : 'Follow'}
                </button>
            );
        }
        return (
            <UserResultCard
                key={r.card.handle}
                user={r.card}
                variant="rich"
                subtitle={r.subtitle}
                trailing={trailing}
                onSelect={mode === 'select' ? () => activate(r) : undefined}
            />
        );
    };

    const isInline = variant === 'inline';
    const listCls = isInline
        ? 'divide-y divide-line overflow-hidden rounded-card bg-surface shadow-sm'
        : 'divide-y divide-line';
    const eyebrowCls = 'text-2xs font-semibold uppercase tracking-wide text-ink-soft';

    const header = variant === 'overlay' && (
        <OverlayHeader
            title={mode === 'select' ? 'Select people' : 'Find people'}
            onBack={onBack}
            action={
                mode === 'select' && selected.length > 0 ? (
                    <button
                        type="button"
                        onClick={() => selected.forEach((h) => onToggleSelect?.(h))}
                        className="inline-flex min-h-11 shrink-0 items-center px-3 text-sm font-medium text-action hover:opacity-80 active:opacity-60"
                        data-testid="specific-people-clear"
                    >
                        Clear
                    </button>
                ) : undefined
            }
        />
    );

    const tabBar = showTabs && (
        <div className="shrink-0 px-4 pt-3">
            <div className="flex gap-1 rounded-field bg-canvas p-1" role="tablist">
                {(['network', 'discover'] as Tab[]).map((t) => (
                    <button
                        key={t}
                        type="button"
                        role="tab"
                        aria-selected={tab === t}
                        onClick={() => {
                            setTab(t);
                            setQuery('');
                        }}
                        data-testid={`people-tab-${t}`}
                        className={
                            'inline-flex min-h-10 flex-1 items-center justify-center rounded-field px-3 text-sm font-semibold transition-colors ' +
                            (tab === t
                                ? 'bg-surface text-ink shadow-sm'
                                : 'text-ink-soft hover:text-ink active:opacity-70')
                        }
                    >
                        {t === 'network' ? `My network${followees.length ? ` (${followees.length})` : ''}` : 'Discover'}
                    </button>
                ))}
            </div>
        </div>
    );

    const searchBox = (
        <div className={'shrink-0 ' + (isInline ? 'pt-4' : 'px-4 pt-3 pb-2')}>
            <div className="relative">
                <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="9" cy="9" r="5.5" />
                    <path d="M13.5 13.5L17 17" />
                </svg>
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
                    enterKeyHint="search"
                    autoComplete="off"
                    placeholder={tab === 'network' ? 'Search your network…' : 'Find people…'}
                    aria-label={tab === 'network' ? 'Search your network' : 'Find people'}
                    className={
                        'min-h-11 w-full rounded-field border border-transparent pl-10 pr-11 text-sm text-ink placeholder:text-muted focus:border-action focus:bg-surface focus:outline-none [&::-webkit-search-cancel-button]:hidden ' +
                        (isInline ? 'bg-surface' : 'bg-canvas')
                    }
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => setQuery('')}
                        className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center text-ink-soft hover:text-ink"
                        aria-label="Clear search"
                    >
                        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M5 5l10 10M15 5L5 15" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );

    const selectedChips = mode === 'select' && selectedRows.length > 0 && (
        <div className="shrink-0 border-b border-line pb-2">
            <p className={'px-4 pt-3 ' + eyebrowCls}>Selected · {selectedRows.length}</p>
            <ul className="flex snap-x gap-3 overflow-x-auto overscroll-x-contain px-4 pt-2 [scrollbar-width:none]">
                {selectedRows.map((r) => {
                    const label = r.card.display_name || `@${r.card.handle}`;
                    const first = firstNameOf(r.card.display_name, r.card.handle);
                    return (
                        <li key={r.card.handle} className="shrink-0 snap-start">
                            <button
                                type="button"
                                onClick={() => onToggleSelect?.(r.card.handle)}
                                className="flex w-14 flex-col items-center gap-1 active:opacity-60"
                                aria-label={`Remove ${label}`}
                            >
                                <span className="relative">
                                    {r.card.avatar_url ? (
                                        // eslint-disable-next-line no-restricted-syntax -- avatar
                                        <img src={r.card.avatar_url} alt="" className="h-12 w-12 rounded-full bg-canvas object-cover" />
                                    ) : (
                                        // eslint-disable-next-line no-restricted-syntax -- avatar
                                        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-ink-soft">
                                            {first.replace(/^@/, '').slice(0, 1).toUpperCase()}
                                        </span>
                                    )}
                                    {/* eslint-disable-next-line no-restricted-syntax -- circular remove badge */}
                                    <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-ink text-white">
                                        <svg viewBox="0 0 20 20" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                                            <path d="M5 5l10 10M15 5L5 15" />
                                        </svg>
                                    </span>
                                </span>
                                <span className="w-full truncate text-center text-xs text-ink">{first}</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );

    const emptyCls = 'px-4 py-8 text-center text-sm text-ink-soft';

    const networkPane = (
        <div>
            {loadingFollowees ? (
                <SkeletonRows />
            ) : networkList.length === 0 ? (
                <p className={emptyCls}>
                    {debounced ? `No one in your network matches “${debounced}”.` : "You're not following anyone yet."}
                </p>
            ) : (
                <ul className={listCls}>{networkList.map(renderRow)}</ul>
            )}
        </div>
    );

    const discoverPane = (
        <div className="flex flex-col gap-4">
            {searching ? (
                <div data-testid="tribe-search-results">
                    {results.length === 0 ? (
                        <p className={emptyCls}>No people match “{debounced}”.</p>
                    ) : (
                        <ul className={listCls}>{results.map(renderRow)}</ul>
                    )}
                </div>
            ) : (
                <div>
                    {(loadingSuggestions || (orderedSuggestions && orderedSuggestions.length > 0)) && (
                        <div className={'flex min-h-11 items-center justify-between ' + (isInline ? 'px-1' : 'px-4')}>
                            <span className={eyebrowCls}>Suggestions for you</span>
                            {orderedSuggestions && orderedSuggestions.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setShuffleSeed((s) => s + 1)}
                                    className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-action hover:opacity-80 active:opacity-60"
                                >
                                    Shuffle
                                </button>
                            )}
                        </div>
                    )}
                    {loadingSuggestions ? (
                        <SkeletonRows />
                    ) : orderedSuggestions && orderedSuggestions.length > 0 ? (
                        <ul className={listCls}>{orderedSuggestions.map(renderRow)}</ul>
                    ) : (
                        <div className="px-4 py-8 text-center" data-testid="tribe-no-suggestions">
                            <p className="text-sm font-semibold text-ink">No suggestions right now</p>
                            <p className="mt-1 text-sm text-ink-soft">
                                Try searching for someone, or invite a friend to get started.
                            </p>
                        </div>
                    )}
                </div>
            )}

            {onOpenInvite && (
                <div className={isInline ? '' : 'px-4'}>
                    <button
                        type="button"
                        onClick={onOpenInvite}
                        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-field border border-line bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-canvas active:bg-canvas"
                    >
                        Can't find them? Invite a friend
                    </button>
                </div>
            )}
        </div>
    );

    const body = (
        <div className={'min-h-0 flex-1 overflow-y-auto overscroll-contain ' + (isInline ? 'pt-3 pb-4' : 'pb-4')}>
            {tab === 'network' ? networkPane : discoverPane}
        </div>
    );

    const footerCls = 'shrink-0 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]';
    const primaryCta = 'inline-flex min-h-12 w-full items-center justify-center rounded-field bg-action px-4 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 active:opacity-80';

    const selectFooter = mode === 'select' && !searchFocused && (
        <div className={footerCls}>
            <button
                type="button"
                onClick={() => onDone?.(selected)}
                className={primaryCta}
                data-testid="specific-people-done"
            >
                {selected.length > 0
                    ? `Apply · ${selected.length} ${selected.length === 1 ? 'person' : 'people'}`
                    : 'Done'}
            </button>
        </div>
    );

    const inlineFooter = isInline && (
        <div className="shrink-0 pt-3">
            {followedHandles.size > 0 ? (
                <button
                    type="button"
                    onClick={() => onDone?.([])}
                    className={primaryCta}
                    data-testid="build-tribe-done"
                >
                    Done
                </button>
            ) : (
                onExploreAll && (
                    <button
                        type="button"
                        onClick={onExploreAll}
                        className="inline-flex min-h-12 w-full items-center justify-center rounded-field border border-line bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-canvas active:bg-canvas"
                    >
                        Explore all events
                    </button>
                )
            )}
        </div>
    );

    // --- Inline empty-network acquisition ---------------------------------
    if (isInline) {
        return (
            <div className="flex h-full flex-col" data-testid="build-your-tribe">
                <div className="flex flex-col items-center gap-2 pt-2 text-center">
                    <span className="inline-flex h-16 w-16 items-center justify-center rounded-card bg-blue-50">
                        {peopleIllustration}
                    </span>
                    <h3 className="text-lg font-bold text-ink">Build your tribe</h3>
                    <p className="max-w-xs text-sm text-ink-soft">
                        Follow people you know to see the events they're going to.
                    </p>
                </div>
                {searchBox}
                {body}
                {inlineFooter}
            </div>
        );
    }

    // --- Overlay (avatar-stack landing / Specific-people picker) ----------
    return (
        <div className="flex h-full flex-col bg-surface" data-testid={mode === 'select' ? 'specific-people-picker' : 'find-people-panel'}>
            {header}
            {tabBar}
            {searchBox}
            {selectedChips}
            {body}
            {selectFooter}
        </div>
    );
}
