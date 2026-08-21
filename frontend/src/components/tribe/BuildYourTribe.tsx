/**
 * In-sheet "Build your tribe" acquisition surface for the People filter.
 *
 * Renders inside the People filter section (either as the empty-network
 * primary state, or as an overlay reached from the populated Tribe row to
 * "find more people"). Lets the viewer:
 *   - search users by name/handle (`searchUsers`) and follow inline,
 *   - browse friend-of-friend suggestions (`fetchMySuggestions`) with a
 *     Shuffle re-roll,
 *   - invite a friend, or fall back to exploring all events.
 *
 * Following is a pure network action: it flips the row to "Following",
 * bubbles up via `onFollowed` (parent shows a toast + drives the
 * empty→populated transition), and never selects the person as a
 * "Specific person" filter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    fetchMySuggestions,
    followUser,
    searchUsers,
    type FoFSuggestionItem,
    type UserSearchResult,
} from '../../api';

interface Row {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer?: boolean;
    is_admin_managed?: boolean;
    // Follows-in-common attribution ("Followed by @alice + 2 more").
    preview_head?: string;
    preview_rest?: number;
}

function suggestionToRow(it: FoFSuggestionItem): Row {
    const head = it.mutual_friends_preview[0];
    return {
        handle: it.handle,
        display_name: it.display_name,
        avatar_url: it.avatar_url,
        is_verified_organizer: it.is_verified_organizer,
        is_admin_managed: it.is_admin_managed,
        preview_head: head,
        preview_rest: it.mutual_friend_count - (head ? 1 : 0),
    };
}

function searchResultToRow(u: UserSearchResult): Row {
    const head = u.mutual_friends_preview?.[0];
    return {
        handle: u.handle,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        is_verified_organizer: u.is_verified_organizer,
        is_admin_managed: u.is_admin_managed,
        preview_head: head,
        preview_rest: head ? (u.mutual_friend_count ?? 1) - 1 : 0,
    };
}

function Avatar({ url, name }: { url: string | null; name: string }) {
    if (url) {
        return <img src={url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" loading="lazy" />;
    }
    return (
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-ink-soft">
            {name.replace(/^@/, '').slice(0, 1).toUpperCase()}
        </span>
    );
}

function FollowRow({
    row,
    followed,
    onFollow,
}: {
    row: Row;
    followed: boolean;
    onFollow: (row: Row) => void;
}) {
    const name = row.display_name || `@${row.handle}`;
    return (
        <li className="flex items-center gap-3 py-2">
            <Avatar url={row.avatar_url} name={name} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                    <span className="truncate text-sm font-medium text-ink">{name}</span>
                    {row.is_verified_organizer && (
                        <img src="/orga.png" alt="" title="Verified organizer" className="h-3.5 w-3.5 shrink-0 object-contain" />
                    )}
                    {row.is_admin_managed && (
                        <img src="/badge.png" alt="" title="Curator" className="h-3.5 w-3.5 shrink-0 object-contain" />
                    )}
                </div>
                <div className="truncate text-xs text-ink-soft">
                    {row.preview_head ? (
                        <>
                            Followed by @{row.preview_head}
                            {(row.preview_rest ?? 0) > 0 && ` + ${row.preview_rest} others`}
                        </>
                    ) : (
                        <>@{row.handle}</>
                    )}
                </div>
            </div>
            <button
                type="button"
                onClick={() => onFollow(row)}
                disabled={followed}
                aria-label={followed ? `Following ${row.handle}` : `Follow ${row.handle}`}
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
        </li>
    );
}

const peopleIllustration = (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-12 w-12 text-action" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="18" r="7" />
        <path d="M6 40c0-6.6 5.4-12 12-12s12 5.4 12 12" />
        <circle cx="34" cy="16" r="5.5" />
        <path d="M32 28c5.5 0 10 4.5 10 10" />
    </svg>
);

export default function BuildYourTribe({
    followedHandles,
    onFollowed,
    onExploreAll,
    variant = 'inline',
    onBack,
}: {
    /** Handles already followed this session (for optimistic row state). */
    followedHandles: Set<string>;
    onFollowed: (handle: string, displayName: string) => void;
    onExploreAll?: () => void;
    variant?: 'inline' | 'overlay';
    onBack?: () => void;
}) {
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    const [suggestions, setSuggestions] = useState<Row[] | null>(null);
    const [results, setResults] = useState<Row[]>([]);
    const [loading, setLoading] = useState(true);
    const [shuffleSeed, setShuffleSeed] = useState(0);

    // Debounce the query so typing doesn't spam the search endpoint.
    useEffect(() => {
        const t = setTimeout(() => setDebounced(query.trim()), 250);
        return () => clearTimeout(t);
    }, [query]);

    // Suggestions (friend-of-friend). Re-fetched on Shuffle.
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchMySuggestions({ limit: 20 })
            .then((res) => {
                if (cancelled) return;
                setSuggestions(res.items.map(suggestionToRow));
            })
            .catch(() => {
                if (!cancelled) setSuggestions([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [shuffleSeed]);

    // Global user search when the viewer types a query.
    useEffect(() => {
        if (debounced.length < 2) {
            setResults([]);
            return;
        }
        let cancelled = false;
        searchUsers(debounced, { limit: 20 })
            .then((res) => {
                if (!cancelled) setResults(res.items.map(searchResultToRow));
            })
            .catch(() => {
                if (!cancelled) setResults([]);
            });
        return () => {
            cancelled = true;
        };
    }, [debounced]);

    const handleFollow = useCallback(
        async (row: Row) => {
            const name = row.display_name || `@${row.handle}`;
            onFollowed(row.handle, name);
            try {
                await followUser(row.handle);
                window.dispatchEvent(new Event('network:changed'));
            } catch {
                // Optimistic UI already flipped; a failed follow silently
                // rolls back on the next network refresh.
            }
        },
        [onFollowed],
    );

    // Client-side shuffle so the "Shuffle" affordance re-orders even if the
    // endpoint returns a stable ranking.
    const orderedSuggestions = useMemo(() => {
        if (!suggestions) return null;
        if (shuffleSeed === 0) return suggestions;
        return [...suggestions].sort(() => Math.random() - 0.5);
    }, [suggestions, shuffleSeed]);

    const searching = debounced.length >= 2;

    const header = variant === 'overlay' && (
        <div className="flex items-center justify-between border-b border-line px-1 py-2">
            <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink"
                aria-label="Back"
            >
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 4l-6 6 6 6" />
                </svg>
                Back
            </button>
            <span className="text-sm font-semibold text-ink">Find people</span>
            <span className="w-12" />
        </div>
    );

    return (
        <div className="flex flex-col gap-4" data-testid="build-your-tribe">
            {header}

            {variant === 'inline' && (
                <div className="flex flex-col items-center gap-2 pt-2 text-center">
                    {peopleIllustration}
                    <h3 className="text-base font-semibold text-ink">Build your tribe</h3>
                    <p className="max-w-xs text-sm text-ink-soft">
                        Follow people you know — or discover new ones — to find events they're going to and
                        interested in.
                    </p>
                </div>
            )}

            <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people…"
                aria-label="Search people"
                className="w-full border border-line px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none"
            />

            {searching ? (
                <div data-testid="tribe-search-results">
                    {results.length === 0 ? (
                        <p className="py-4 text-center text-sm text-ink-soft">No people match “{debounced}”.</p>
                    ) : (
                        <ul className="divide-y divide-line">
                            {results.map((row) => (
                                <FollowRow
                                    key={row.handle}
                                    row={row}
                                    followed={followedHandles.has(row.handle)}
                                    onFollow={handleFollow}
                                />
                            ))}
                        </ul>
                    )}
                </div>
            ) : (
                <div>
                    <div className="flex items-center justify-between px-1 pb-1">
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
                    {loading ? (
                        <p className="py-4 text-center text-sm text-ink-soft">Loading…</p>
                    ) : orderedSuggestions && orderedSuggestions.length > 0 ? (
                        <ul className="divide-y divide-line">
                            {orderedSuggestions.map((row) => (
                                <FollowRow
                                    key={row.handle}
                                    row={row}
                                    followed={followedHandles.has(row.handle)}
                                    onFollow={handleFollow}
                                />
                            ))}
                        </ul>
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

            <div className="flex flex-col gap-2 border-t border-line pt-3">
                <Link to="/invite" className="text-sm font-medium text-action hover:opacity-80">
                    Can't find them? Invite a friend →
                </Link>
                {variant === 'inline' && onExploreAll && (
                    <button
                        type="button"
                        onClick={onExploreAll}
                        className="inline-flex w-full items-center justify-center border border-line bg-surface px-3 py-2.5 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                        Explore all events
                    </button>
                )}
            </div>
        </div>
    );
}
