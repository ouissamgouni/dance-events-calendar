/**
 * Searchable user-picker for the explorer interest filter.
 *
 * Composition:
 *   - Debounced (250 ms) text input + popover; reuses the same UX shape
 *     as the header `UserSearchBox` so users only learn one pattern.
 *   - Two-tier source:
 *       1. With an empty query, lists the viewer's followees
 *          (friends-first), via `GET /api/social/me/following`.
 *       2. With a query, falls back to global user search
 *          (`GET /api/social/search/users`) so the viewer can also pick
 *          someone they don't yet follow.
 *   - After the rows resolve, batches one `GET /api/social/users/
 *     interest-summary?handles=…` call to enrich each card with
 *     visibility-filtered upcoming counts.
 *   - Renders rows through the shared `UserResultCard` (variant="rich").
 *
 * Picking calls `onPick(handle)` and closes the popover. The picker
 * does not navigate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    fetchCurators,
    fetchInterestSummary,
    fetchMyFollowing,
    followUser,
    searchUsers,
    type FollowUser,
    type InterestSummaryItem,
    type UserSearchResult,
} from '../api';
import UserResultCard, { type UserCardModel } from './UserResultCard';

interface Props {
    onPick: (handle: string) => void;
    onClose: () => void;
}

export default function UserInterestPicker({ onPick, onClose }: Props) {
    const [q, setQ] = useState('');
    const [rows, setRows] = useState<UserCardModel[]>([]);
    const [suggestions, setSuggestions] = useState<UserCardModel[]>([]);
    const [loading, setLoading] = useState(false);
    const [metrics, setMetrics] = useState<Map<string, InterestSummaryItem>>(new Map());
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounced = useDebounced(q, 250);
    const [activeIdx, setActiveIdx] = useState(0);

    // Click-outside / Esc to close. The picker does not preserve state
    // — re-opening starts fresh, matching the header search.
    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                onClose();
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [onClose]);
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Row source. Empty query → followees; non-empty → global search.
    // When that primary source is empty, show curators as an explicit
    // Suggestions section instead of pretending they are followees.
    useEffect(() => {
        const term = debounced.trim();
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- spinner before async fetch, matches header UserSearchBox pattern
        setLoading(true);
        setSuggestions([]);
        const run = async () => {
            const items = term.length >= 2
                ? (await searchUsers(term, { limit: 12 })).items.map(searchResultToCard)
                : (await fetchMyFollowing({ limit: 25 })).items.map(followUserToCard);
            const fallback = items.length === 0
                ? (await fetchCurators({
                    limit: 12,
                    excludeFollowed: true,
                })).items.map(searchResultToCard)
                : [];
            return { items, fallback };
        };
        run()
            .then(({ items, fallback }) => {
                if (cancelled) return;
                setRows(items);
                setSuggestions(fallback);
                setActiveIdx(items.length > 0 || fallback.length > 0 ? 0 : -1);
            })
            .catch(() => {
                if (!cancelled) {
                    setRows([]);
                    setSuggestions([]);
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [debounced]);

    // Enrich with upcoming-activity counts, one batched call per row set.
    // Skipped when there are no rows (avoids a no-op request).
    useEffect(() => {
        const users = [...rows, ...suggestions];
        if (users.length === 0) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- short-circuit reset when no rows to enrich
            setMetrics(new Map());
            return;
        }
        let cancelled = false;
        fetchInterestSummary(users.map((r) => r.handle))
            .then((items) => {
                if (cancelled) return;
                const m = new Map<string, InterestSummaryItem>();
                for (const it of items) m.set(it.handle, it);
                setMetrics(m);
            })
            .catch(() => {
                if (!cancelled) setMetrics(new Map());
            });
        return () => {
            cancelled = true;
        };
    }, [rows, suggestions]);

    const visibleRows = rows.length > 0 ? rows : suggestions;

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => Math.min(visibleRows.length - 1, i + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, i - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIdx >= 0 && visibleRows[activeIdx]) {
                onPick(visibleRows[activeIdx].handle);
            }
        }
    };

    const handleFollow = useCallback(async (handle: string) => {
        // Optimistic: mark the row as followed; the server response is
        // authoritative on next refetch. Errors silently roll back so we
        // don't trap the user in a confusing toast state inside a popover.
        setRows((prev) =>
            prev.map((r) =>
                r.handle === handle ? { ...r, is_followed_by_viewer: true } : r,
            ),
        );
        setSuggestions((prev) =>
            prev.map((r) =>
                r.handle === handle ? { ...r, is_followed_by_viewer: true } : r,
            ),
        );
        try {
            await followUser(handle);
            window.dispatchEvent(new Event('network:changed'));
        } catch {
            setRows((prev) =>
                prev.map((r) =>
                    r.handle === handle
                        ? { ...r, is_followed_by_viewer: false }
                        : r,
                ),
            );
            setSuggestions((prev) =>
                prev.map((r) =>
                    r.handle === handle
                        ? { ...r, is_followed_by_viewer: false }
                        : r,
                ),
            );
        }
    }, []);

    return (
        <div
            ref={containerRef}
            className="absolute z-50 mt-1 w-72 max-w-[calc(100vw-1rem)] bg-white border border-slate-200 shadow-lg"
        >
            <div className="p-2 border-b border-slate-100">
                <input
                    ref={inputRef}
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search people you follow…"
                    aria-label="Search people you follow"
                    className="w-full text-xs px-2 py-1 border border-slate-200 focus:outline-none focus:border-blue-500"
                />
            </div>
            <div className="max-h-80 overflow-auto">
                {loading && (
                    <div className="p-3 text-xs text-slate-500">Loading…</div>
                )}
                {!loading && rows.length === 0 && suggestions.length === 0 && (
                    <div className="p-3 text-xs text-slate-500">
                        {debounced.trim().length >= 2
                            ? `No users match “${debounced.trim()}”.`
                            : "You're not following anyone yet."}
                    </div>
                )}
                {!loading &&
                    rows.map((u, i) => (
                        <UserResultCard
                            key={u.handle}
                            user={u}
                            variant="rich"
                            active={i === activeIdx}
                            metrics={metrics.get(u.handle)}
                            onSelect={(picked) => onPick(picked.handle)}
                            trailing={
                                u.is_followed_by_viewer === false ? (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void handleFollow(u.handle);
                                        }}
                                        className="px-2 py-0.5 text-[11px] bg-blue-500 text-white border border-blue-500 hover:bg-blue-600"
                                    >
                                        Follow
                                    </button>
                                ) : undefined
                            }
                        />
                    ))}
                {!loading && rows.length === 0 && suggestions.length > 0 && (
                    <>
                        <div className="px-3 pt-3 pb-1 border-t border-slate-100">
                            <div className="text-[11px] font-semibold text-slate-700 uppercase">
                                Suggestions
                            </div>
                            <div className="text-[11px] text-slate-500">
                                Curators you can follow
                            </div>
                        </div>
                        {suggestions.map((u, i) => (
                            <UserResultCard
                                key={u.handle}
                                user={u}
                                variant="rich"
                                active={i === activeIdx}
                                metrics={metrics.get(u.handle)}
                                onSelect={(picked) => onPick(picked.handle)}
                                trailing={
                                    u.is_followed_by_viewer === false ? (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void handleFollow(u.handle);
                                            }}
                                            className="px-2 py-0.5 text-[11px] bg-blue-500 text-white border border-blue-500 hover:bg-blue-600"
                                        >
                                            Follow
                                        </button>
                                    ) : undefined
                                }
                            />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

function searchResultToCard(u: UserSearchResult): UserCardModel {
    return {
        handle: u.handle,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        is_verified_organizer: u.is_verified_organizer,
        is_admin_managed: u.is_admin_managed,
        // Intentionally omit subscribers_count: the picker shows
        // interest metrics (going/saved) on the secondary line; mixing
        // in "N subscribers" would visually diverge from the followees
        // tier where that count is unavailable.
        is_friend: u.is_friend,
        is_followed_by_viewer: u.is_followed_by_viewer,
    };
}

function followUserToCard(u: FollowUser): UserCardModel {
    return {
        handle: u.handle,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        is_verified_organizer: u.is_verified_organizer,
        is_friend: u.is_friend,
        // /me/following is by definition users the viewer follows.
        is_followed_by_viewer: true,
    };
}

function useDebounced<T>(value: T, ms: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const id = window.setTimeout(() => setDebounced(value), ms);
        return () => window.clearTimeout(id);
    }, [value, ms]);
    return debounced;
}
