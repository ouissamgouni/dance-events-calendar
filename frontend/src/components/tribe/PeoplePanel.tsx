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
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4l-6 6 6 6" />
        </svg>
    );
}

function CheckBox({ checked }: { checked: boolean }) {
    return (
        <span
            aria-hidden="true"
            className={
                'inline-flex h-5 w-5 shrink-0 items-center justify-center border ' +
                (checked ? 'border-action bg-action text-white' : 'border-line bg-surface')
            }
        >
            {checked && (
                <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 10.5l4 4 8-8" />
                </svg>
            )}
        </span>
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
            trailing = <CheckBox checked={selected.includes(r.card.handle)} />;
        } else if (tab === 'network') {
            trailing = <span className="text-[11px] text-ink-soft">Following</span>;
        } else {
            trailing = (
                <button
                    type="button"
                    onClick={() => void doFollow(r)}
                    disabled={followed}
                    aria-label={followed ? `Following ${r.card.handle}` : `Follow ${r.card.handle}`}
                    aria-pressed={followed}
                    className={
                        'shrink-0 border px-3 py-1 text-xs font-medium transition ' +
                        (followed
                            ? 'border-line bg-surface text-ink-soft'
                            : 'border-action bg-action text-white hover:opacity-90')
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

    const header = variant === 'overlay' && (
        <div className="flex items-center justify-between border-b border-line px-2 py-2">
            <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink"
                aria-label="Back"
            >
                <BackIcon />
                Back
            </button>
            <span className="text-sm font-semibold text-ink">
                {mode === 'select' ? 'Select people' : 'Find people'}
            </span>
            {mode === 'select' ? (
                <button
                    type="button"
                    onClick={() => onDone?.(selected)}
                    className="text-sm font-semibold text-action hover:opacity-80"
                    data-testid="specific-people-done"
                >
                    Done
                </button>
            ) : (
                <span className="w-12" />
            )}
        </div>
    );

    const tabBar = showTabs && (
        <div className="flex border-b border-line" role="tablist">
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
                        'flex-1 px-3 py-2 text-sm font-medium transition ' +
                        (tab === t
                            ? 'border-b-2 border-action text-action'
                            : 'text-ink-soft hover:text-ink')
                    }
                >
                    {t === 'network' ? `My network${followees.length ? ` (${followees.length})` : ''}` : 'Discover'}
                </button>
            ))}
        </div>
    );

    const searchBox = (
        <div className="px-3 pt-3">
            <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'network' ? 'Search your network…' : 'Find people…'}
                aria-label={tab === 'network' ? 'Search your network' : 'Find people'}
                className="w-full border border-line px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none"
            />
        </div>
    );

    const selectedChips = mode === 'select' && selectedRows.length > 0 && (
        <div className="border-b border-line px-3 py-2">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                Selected ({selectedRows.length})
            </p>
            <div className="flex flex-wrap gap-1.5">
                {selectedRows.map((r) => {
                    const label = r.card.display_name || `@${r.card.handle}`;
                    return (
                        <button
                            type="button"
                            key={r.card.handle}
                            onClick={() => onToggleSelect?.(r.card.handle)}
                            className="inline-flex items-center gap-1.5 border border-blue-200 bg-blue-50 py-0.5 px-2 text-xs text-action"
                            aria-label={`Remove ${label}`}
                        >
                            <span className="max-w-[8rem] truncate">{label}</span>
                            <span aria-hidden="true">×</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );

    const networkPane = (
        <div>
            {loadingFollowees ? (
                <p className="py-4 text-center text-sm text-ink-soft">Loading…</p>
            ) : networkList.length === 0 ? (
                <p className="py-4 text-center text-sm text-ink-soft">
                    {debounced ? `No one in your network matches “${debounced}”.` : "You're not following anyone yet."}
                </p>
            ) : (
                <ul className="divide-y divide-line">{networkList.map(renderRow)}</ul>
            )}
        </div>
    );

    const discoverPane = (
        <div className="flex flex-col gap-3">
            {searching ? (
                <div data-testid="tribe-search-results">
                    {results.length === 0 ? (
                        <p className="py-4 text-center text-sm text-ink-soft">No people match “{debounced}”.</p>
                    ) : (
                        <ul className="divide-y divide-line">{results.map(renderRow)}</ul>
                    )}
                </div>
            ) : (
                <div>
                    {(loadingSuggestions || (orderedSuggestions && orderedSuggestions.length > 0)) && (
                        <div className="flex items-center justify-between px-1 pb-1 pt-3">
                            <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                                Suggestions for you
                            </span>
                            {orderedSuggestions && orderedSuggestions.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setShuffleSeed((s) => s + 1)}
                                    className="text-xs font-medium text-action hover:opacity-80"
                                >
                                    Shuffle
                                </button>
                            )}
                        </div>
                    )}
                    {loadingSuggestions ? (
                        <p className="py-4 text-center text-sm text-ink-soft">Loading…</p>
                    ) : orderedSuggestions && orderedSuggestions.length > 0 ? (
                        <ul className="divide-y divide-line">{orderedSuggestions.map(renderRow)}</ul>
                    ) : (
                        <div className="py-4 text-center" data-testid="tribe-no-suggestions">
                            <p className="text-sm font-medium text-ink">No suggestions right now</p>
                            <p className="mt-1 text-sm text-ink-soft">
                                Try searching for someone, or invite a friend to get started.
                            </p>
                        </div>
                    )}
                </div>
            )}

            <div className="border-t border-line pt-3">
                <button
                    type="button"
                    onClick={onOpenInvite}
                    className="text-sm font-medium text-action hover:opacity-80"
                >
                    Can't find them? Invite a friend →
                </button>
            </div>
        </div>
    );

    const body = (
        <div className="flex-1 overflow-y-auto px-3 pb-3">
            {tab === 'network' ? networkPane : discoverPane}
        </div>
    );

    const inlineFooter = variant === 'inline' && (
        <div className="border-t border-line px-3 py-2">
            {followedHandles.size > 0 ? (
                <button
                    type="button"
                    onClick={() => onDone?.([])}
                    className="w-full bg-action px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90"
                    data-testid="build-tribe-done"
                >
                    Done
                </button>
            ) : (
                onExploreAll && (
                    <button
                        type="button"
                        onClick={onExploreAll}
                        className="inline-flex w-full items-center justify-center border border-line bg-surface px-3 py-2.5 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                        Explore all events
                    </button>
                )
            )}
        </div>
    );

    // --- Inline empty-network acquisition ---------------------------------
    if (variant === 'inline') {
        return (
            <div className="flex h-full flex-col" data-testid="build-your-tribe">
                <div className="flex flex-col items-center gap-2 px-3 pt-3 text-center">
                    {peopleIllustration}
                    <h3 className="text-base font-semibold text-ink">Build your tribe</h3>
                    <p className="max-w-xs text-sm text-ink-soft">
                        Follow people you know — or discover new ones — to find events they're going to and
                        interested in.
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
        <div className="flex h-full flex-col" data-testid={mode === 'select' ? 'specific-people-picker' : 'find-people-panel'}>
            {header}
            {tabBar}
            {selectedChips}
            {searchBox}
            {body}
        </div>
    );
}
