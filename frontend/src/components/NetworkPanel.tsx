import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
    fetchFollowingMostActive,
    fetchMyFollowers,
    fetchMyFollowing,
    fetchMyFriends,
    fetchFollowRequests,
    followUser,
    removeMyFollower,
    searchUsers,
    unfollowUser,
    type FollowingActivityPeriod,
    type FollowingMostActiveResponse,
    type FollowList,
    type FollowUser,
    type UserSearchResult,
} from '../api';
import FollowRequestsPanel from './FollowRequestsPanel';
import SuggestionsCarousel from './SuggestionsCarousel';
import PersonRowMenu, { type RowMenuItem } from './PersonRowMenu';
import UserResultCard from './UserResultCard';
import ScrollDotsIndicator from './ScrollDots';
import { ConfirmDialog } from './AppDialog';
import { useScrollDots } from '../hooks/useScrollDots';

/**
 * The People page (`/tribe/network`). Lets the signed-in user discover
 * people to follow and manage their follow graph.
 *
 * Top tabs: Following (default, with All following / Most active
 * sub-views) · Followers · Friends · Requests. Tab / sub-view / period /
 * search state live in the URL so returning from a profile restores the
 * exact view.
 */

type Tab = 'following' | 'followers' | 'friends' | 'requests';
type SubView = 'all' | 'active';
type ListTab = 'followers' | 'following' | 'friends';

const PERIOD_ORDER: FollowingActivityPeriod[] = ['365d', '180d', '90d'];
const PERIOD_LABEL: Record<FollowingActivityPeriod, string> = {
    '365d': '1 year',
    '180d': '6 months',
    '90d': '3 months',
};

function isTab(v: string | null): v is Tab {
    return v === 'following' || v === 'followers' || v === 'friends' || v === 'requests';
}

export default function NetworkPanel() {
    const [params, setParams] = useSearchParams();
    const tab: Tab = isTab(params.get('tab')) ? (params.get('tab') as Tab) : 'following';
    const sub: SubView = params.get('sub') === 'active' ? 'active' : 'all';
    const periodParam = params.get('period');
    const period: FollowingActivityPeriod = PERIOD_ORDER.includes(
        periodParam as FollowingActivityPeriod,
    )
        ? (periodParam as FollowingActivityPeriod)
        : '365d';
    const q = params.get('q') ?? '';

    const setParam = useCallback(
        (key: string, value: string | null) => {
            setParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    if (value) next.set(key, value);
                    else next.delete(key);
                    return next;
                },
                { replace: true },
            );
        },
        [setParams],
    );

    // --- follow-graph lists -------------------------------------------------
    const [listData, setListData] = useState<Record<ListTab, FollowList | null>>({
        followers: null,
        following: null,
        friends: null,
    });
    const [counts, setCounts] = useState<Record<ListTab, number | null>>({
        followers: null,
        following: null,
        friends: null,
    });
    const [requestCount, setRequestCount] = useState(0);
    const [mostActive, setMostActive] = useState<FollowingMostActiveResponse | null>(null);
    const [errors, setErrors] = useState<Record<string, string | null>>({});
    const [pending, setPending] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<{
        title: string;
        message: string;
        confirmLabel: string;
        run: () => Promise<void>;
    } | null>(null);

    const searchRef = useRef<HTMLInputElement>(null);
    const tablistRef = useRef<HTMLDivElement>(null);

    const invalidate = useCallback(() => {
        setListData({ followers: null, following: null, friends: null });
        setMostActive(null);
    }, []);

    // Eager tab-badge counts (followers/following/friends + pending requests).
    const loadCounts = useCallback(() => {
        Promise.all([
            fetchMyFollowing({ limit: 1 }),
            fetchMyFollowers({ limit: 1 }),
            fetchMyFriends({ limit: 1 }),
        ])
            .then(([following, followers, friends]) =>
                setCounts({
                    following: following.total,
                    followers: followers.total,
                    friends: friends.total,
                }),
            )
            .catch(() => undefined);
        fetchFollowRequests()
            .then((r) => setRequestCount(r.items.length))
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        loadCounts();
        const onChanged = () => {
            invalidate();
            loadCounts();
        };
        window.addEventListener('network:changed', onChanged);
        return () => window.removeEventListener('network:changed', onChanged);
    }, [invalidate, loadCounts]);

    // Load the active list tab.
    useEffect(() => {
        if (q) return; // search mode replaces content
        if (tab === 'requests') return;
        if (tab === 'following' && sub === 'active') return; // handled below
        const listTab = tab as ListTab;
        if (listData[listTab] !== null) return;
        let cancelled = false;
        const fetcher =
            listTab === 'friends'
                ? fetchMyFriends
                : listTab === 'followers'
                    ? fetchMyFollowers
                    : fetchMyFollowing;
        fetcher({ limit: 100 })
            .then((res) => {
                if (!cancelled) setListData((d) => ({ ...d, [listTab]: res }));
            })
            .catch((err) => {
                if (!cancelled)
                    setErrors((e) => ({
                        ...e,
                        [listTab]: err instanceof Error ? err.message : 'Failed to load',
                    }));
            });
        return () => {
            cancelled = true;
        };
    }, [tab, sub, q, listData]);

    // Load "Most active" ranking.
    useEffect(() => {
        if (q) return;
        if (!(tab === 'following' && sub === 'active')) return;
        if (mostActive !== null && mostActive.period === period) return;
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale ranking before period refetch
        setMostActive(null);
        fetchFollowingMostActive({ period, limit: 50 })
            .then((res) => {
                if (!cancelled) setMostActive(res);
            })
            .catch((err) => {
                if (!cancelled)
                    setErrors((e) => ({
                        ...e,
                        mostActive: err instanceof Error ? err.message : 'Failed to load',
                    }));
            });
        return () => {
            cancelled = true;
        };
    }, [tab, sub, period, q, mostActive]);

    // --- search -------------------------------------------------------------
    const [searchInput, setSearchInput] = useState(q);
    const [results, setResults] = useState<UserSearchResult[] | null>(null);
    const [searching, setSearching] = useState(false);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- sync URL param into the local input
        setSearchInput(q);
    }, [q]);

    // Debounce the input into the ?q= param.
    useEffect(() => {
        const trimmed = searchInput.trim();
        if (trimmed === q) return;
        const t = setTimeout(() => setParam('q', trimmed || null), 300);
        return () => clearTimeout(t);
    }, [searchInput, q, setParam]);

    useEffect(() => {
        const term = q.trim();
        if (!term) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- short-circuit reset when search is cleared
            setResults(null);
            return;
        }
        let cancelled = false;
        setSearching(true);
        searchUsers(term, { limit: 25 })
            .then((res) => {
                if (!cancelled) setResults(res.items);
            })
            .catch(() => {
                if (!cancelled) setResults([]);
            })
            .finally(() => {
                if (!cancelled) setSearching(false);
            });
        return () => {
            cancelled = true;
        };
    }, [q]);

    // --- actions ------------------------------------------------------------
    const runUnfollow = useCallback(
        async (handle: string) => {
            setPending(handle);
            try {
                await unfollowUser(handle);
                invalidate();
                window.dispatchEvent(new Event('network:changed'));
            } finally {
                setPending(null);
            }
        },
        [invalidate],
    );

    const runRemoveFollower = useCallback(async (handle: string) => {
        setPending(handle);
        try {
            await removeMyFollower(handle);
            window.dispatchEvent(new Event('network:changed'));
        } finally {
            setPending(null);
        }
    }, []);

    const handleFollow = useCallback(async (handle: string) => {
        setPending(handle);
        try {
            await followUser(handle);
            setResults((prev) =>
                prev
                    ? prev.map((r) =>
                        r.handle === handle ? { ...r, is_followed_by_viewer: true } : r,
                    )
                    : prev,
            );
            window.dispatchEvent(new Event('network:changed'));
        } finally {
            setPending(null);
        }
    }, []);

    const followingTotal = listData.following?.total ?? counts.following;

    const tabDefs: { key: Tab; label: string; count: number | null }[] = useMemo(
        () => [
            { key: 'following', label: 'Following', count: followingTotal },
            { key: 'followers', label: 'Followers', count: counts.followers },
            { key: 'friends', label: 'Friends', count: counts.friends },
            { key: 'requests', label: 'Requests', count: requestCount || null },
        ],
        [followingTotal, counts.followers, counts.friends, requestCount],
    );

    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(tablistRef, [tabDefs.length]);

    return (
        <div>
            <h1 className="mb-4 text-2xl font-bold text-ink">People</h1>

            {/* Discover / search block */}
            <div className="mb-5">
                <h2 className="text-base font-semibold text-ink">Discover people</h2>
                <p className="mt-0.5 text-sm text-ink-soft">
                    Find dancers, organizers, and venues to follow.
                </p>
                <input
                    ref={searchRef}
                    type="search"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search by name or handle…"
                    aria-label="Search by name or handle"
                    className="mt-3 w-full border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                    style={{ height: 54 }}
                />
                <p className="mt-2 text-xs text-ink-soft">
                    Can’t find them?{' '}
                    <Link to="/invite" className="font-medium text-action hover:underline">
                        Invite a friend →
                    </Link>
                </p>
            </div>

            {q ? (
                <SearchResults
                    term={q}
                    loading={searching}
                    results={results}
                    pending={pending}
                    onFollow={(h) => void handleFollow(h)}
                    onClear={() => setParam('q', null)}
                />
            ) : (
                <>
                    <SuggestionsCarousel />

                    {/* Top-level tabs */}
                    <div
                        ref={tablistRef}
                        role="tablist"
                        aria-label="People"
                        className="sticky top-0 z-10 -mx-4 mb-4 flex gap-5 border-b border-line bg-surface px-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    >
                        {tabDefs.map((t) => {
                            const active = t.key === tab;
                            return (
                                <button
                                    key={t.key}
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    onClick={() => setParam('tab', t.key)}
                                    className={`-mb-px shrink-0 border-b-2 py-2 text-sm whitespace-nowrap ${active
                                            ? 'border-action font-semibold text-ink'
                                            : 'border-transparent font-normal text-ink-soft hover:text-ink'
                                        }`}
                                >
                                    {t.label}
                                    {typeof t.count === 'number' && (
                                        <span className="ml-1.5 text-xs text-muted">{t.count}</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex justify-center mb-3">
                        <ScrollDotsIndicator count={dotCount} activeIndex={activeIndex} onSelect={scrollToIndex} />
                    </div>

                    {tab === 'following' && (
                        <FollowingView
                            sub={sub}
                            period={period}
                            onSubChange={(s) => setParam('sub', s === 'all' ? null : s)}
                            onPeriodChange={(p) => setParam('period', p === '365d' ? null : p)}
                            list={listData.following}
                            mostActive={mostActive}
                            error={errors.following || errors.mostActive || null}
                            pending={pending}
                            onFindPeople={() => {
                                searchRef.current?.scrollIntoView({ behavior: 'smooth' });
                                searchRef.current?.focus();
                            }}
                            onUnfollow={(u) =>
                                setConfirm({
                                    title: u.is_friend ? 'Remove friend' : 'Unfollow',
                                    message: `${u.is_friend ? 'Remove' : 'Unfollow'} ${u.display_name || `@${u.handle}`
                                        }?`,
                                    confirmLabel: u.is_friend ? 'Remove' : 'Unfollow',
                                    run: () => runUnfollow(u.handle),
                                })
                            }
                            onUnfollowHandle={(handle, name) =>
                                setConfirm({
                                    title: 'Unfollow',
                                    message: `Unfollow ${name}?`,
                                    confirmLabel: 'Unfollow',
                                    run: () => runUnfollow(handle),
                                })
                            }
                        />
                    )}

                    {tab === 'followers' && (
                        <PersonList
                            tab="followers"
                            data={listData.followers}
                            error={errors.followers || null}
                            pending={pending}
                            onFollow={(h) => void handleFollow(h)}
                            onMenuUnfollow={(u) =>
                                setConfirm({
                                    title: 'Remove follower',
                                    message: `Remove ${u.display_name || `@${u.handle}`} from your followers?`,
                                    confirmLabel: 'Remove',
                                    run: () => runRemoveFollower(u.handle),
                                })
                            }
                        />
                    )}

                    {tab === 'friends' && (
                        <PersonList
                            tab="friends"
                            data={listData.friends}
                            error={errors.friends || null}
                            pending={pending}
                            onMenuUnfollow={(u) =>
                                setConfirm({
                                    title: 'Remove friend',
                                    message: `Remove ${u.display_name || `@${u.handle}`} as a friend?`,
                                    confirmLabel: 'Remove',
                                    run: () => runUnfollow(u.handle),
                                })
                            }
                        />
                    )}

                    {tab === 'requests' && (
                        <FollowRequestsPanel variant="tab" onCount={setRequestCount} />
                    )}
                </>
            )}

            <ConfirmDialog
                open={confirm !== null}
                title={confirm?.title || ''}
                message={confirm?.message || ''}
                confirmLabel={confirm?.confirmLabel || 'Confirm'}
                onCancel={() => setConfirm(null)}
                onConfirm={() => {
                    const c = confirm;
                    setConfirm(null);
                    if (c) void c.run();
                }}
            />
        </div>
    );
}

// --- Following view (All following + Most active) ---------------------------

function FollowingView({
    sub,
    period,
    onSubChange,
    onPeriodChange,
    list,
    mostActive,
    error,
    pending,
    onFindPeople,
    onUnfollow,
    onUnfollowHandle,
}: {
    sub: SubView;
    period: FollowingActivityPeriod;
    onSubChange: (s: SubView) => void;
    onPeriodChange: (p: FollowingActivityPeriod) => void;
    list: FollowList | null;
    mostActive: FollowingMostActiveResponse | null;
    error: string | null;
    pending: string | null;
    onFindPeople: () => void;
    onUnfollow: (u: FollowUser) => void;
    onUnfollowHandle: (handle: string, name: string) => void;
}) {
    return (
        <div>
            <div className="mb-4 inline-flex" role="group" aria-label="Following view">
                {(['all', 'active'] as SubView[]).map((s, i) => {
                    const active = s === sub;
                    return (
                        <button
                            key={s}
                            type="button"
                            aria-pressed={active}
                            onClick={() => onSubChange(s)}
                            className={`h-9 border px-4 text-sm ${i === 0 ? 'rounded-l' : '-ml-px rounded-r'} ${active
                                    ? 'border-action bg-action/5 font-semibold text-ink'
                                    : 'border-line bg-surface font-normal text-ink-soft hover:text-ink'
                                }`}
                        >
                            {s === 'all' ? 'All following' : 'Most active'}
                        </button>
                    );
                })}
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}

            {sub === 'all' ? (
                list === null ? (
                    <p className="text-xs text-muted">Loading…</p>
                ) : list.items.length === 0 ? (
                    <div className="py-8 text-center">
                        <p className="text-sm text-ink-soft">You’re not following anyone yet.</p>
                        <button
                            type="button"
                            onClick={onFindPeople}
                            className="mt-3 border border-line px-3 py-1.5 text-sm font-medium text-action hover:bg-canvas"
                        >
                            Find people
                        </button>
                    </div>
                ) : (
                    <>
                        <p className="mb-1 text-xs font-medium text-ink-soft">
                            {list.total} {list.total === 1 ? 'person' : 'people'}
                        </p>
                        <ul className="divide-y divide-line">
                            {list.items.map((u) => (
                                <PersonRow
                                    key={u.handle}
                                    user={u}
                                    relationship={u.is_friend ? 'Friend' : 'Following'}
                                    menuItems={[
                                        {
                                            label: u.is_friend ? 'Remove friend' : 'Unfollow',
                                            danger: true,
                                            onSelect: () => onUnfollow(u),
                                        },
                                    ]}
                                    disabled={pending === u.handle}
                                />
                            ))}
                        </ul>
                    </>
                )
            ) : (
                <MostActiveView
                    period={period}
                    onPeriodChange={onPeriodChange}
                    data={mostActive}
                    pending={pending}
                    onUnfollow={onUnfollowHandle}
                />
            )}
        </div>
    );
}

function MostActiveView({
    period,
    onPeriodChange,
    data,
    pending,
    onUnfollow,
}: {
    period: FollowingActivityPeriod;
    onPeriodChange: (p: FollowingActivityPeriod) => void;
    data: FollowingMostActiveResponse | null;
    pending: string | null;
    onUnfollow: (handle: string, name: string) => void;
}) {
    return (
        <div data-testid="following-most-active">
            <div className="mb-4 flex gap-2" role="group" aria-label="Activity period">
                {PERIOD_ORDER.map((p) => {
                    const active = p === period;
                    return (
                        <button
                            key={p}
                            type="button"
                            aria-pressed={active}
                            onClick={() => onPeriodChange(p)}
                            className={`h-9 border px-3 text-sm ${active
                                    ? 'border-action bg-action/5 font-semibold text-ink'
                                    : 'border-line bg-surface font-normal text-ink-soft hover:text-ink'
                                }`}
                        >
                            {PERIOD_LABEL[p]}
                        </button>
                    );
                })}
            </div>
            {data === null ? (
                <p className="text-xs text-muted">Loading…</p>
            ) : data.items.length === 0 ? (
                <div className="py-8 text-center">
                    <p className="text-sm text-ink-soft">No activity in this period.</p>
                    <p className="mt-1 text-xs text-muted">Try a longer time period.</p>
                </div>
            ) : (
                <ol className="divide-y divide-line">
                    {data.items.map((row) => {
                        const name = row.display_name || `@${row.handle}`;
                        return (
                            <li key={row.handle} className="flex items-center gap-3 py-3">
                                <span className="w-5 shrink-0 text-right text-sm font-semibold text-ink-soft">
                                    {row.rank}
                                </span>
                                <Avatar url={row.avatar_url} name={name} />
                                <div className="min-w-0 flex-1">
                                    <Link
                                        to={`/u/${row.handle}`}
                                        className="block truncate text-sm font-medium text-ink hover:text-action"
                                    >
                                        {name}
                                        {row.is_verified_organizer && <VerifiedTick />}
                                    </Link>
                                    <div className="truncate text-xs text-ink-soft">
                                        @{row.handle}
                                    </div>
                                </div>
                                <span className="shrink-0 text-xs text-ink-soft">
                                    {row.going_count} {row.going_count === 1 ? 'event' : 'events'}
                                </span>
                                <PersonRowMenu
                                    label={`Actions for ${name}`}
                                    items={[
                                        {
                                            label: 'Unfollow',
                                            danger: true,
                                            onSelect: () => onUnfollow(row.handle, name),
                                        },
                                    ]}
                                />
                            </li>
                        );
                    })}
                </ol>
            )}
            {pending && <span className="sr-only">Working…</span>}
        </div>
    );
}

// --- Followers / Friends lists ----------------------------------------------

function PersonList({
    tab,
    data,
    error,
    pending,
    onFollow,
    onMenuUnfollow,
}: {
    tab: 'followers' | 'friends';
    data: FollowList | null;
    error: string | null;
    pending: string | null;
    onFollow?: (handle: string) => void;
    onMenuUnfollow: (u: FollowUser) => void;
}) {
    if (error) return <p className="text-xs text-danger">{error}</p>;
    if (data === null) return <p className="text-xs text-muted">Loading…</p>;
    if (data.items.length === 0) {
        return (
            <p className="py-8 text-center text-sm text-ink-soft">
                {tab === 'followers'
                    ? 'No one is following you yet.'
                    : 'You don’t have any friends yet. Friends follow you back.'}
            </p>
        );
    }
    return (
        <ul className="divide-y divide-line">
            {data.items.map((u) => {
                const menuItems: RowMenuItem[] = [
                    {
                        label: tab === 'followers' ? 'Remove follower' : 'Remove friend',
                        danger: true,
                        onSelect: () => onMenuUnfollow(u),
                    },
                ];
                const relationship =
                    tab === 'friends' ? 'Friend' : u.is_friend ? 'Friend' : 'Follows you';
                return (
                    <PersonRow
                        key={u.handle}
                        user={u}
                        relationship={relationship}
                        menuItems={menuItems}
                        disabled={pending === u.handle}
                        trailing={
                            tab === 'followers' && !u.is_friend && onFollow ? (
                                <button
                                    type="button"
                                    onClick={() => onFollow(u.handle)}
                                    disabled={pending === u.handle}
                                    className="border border-line px-2.5 py-1 text-xs font-semibold text-action hover:bg-canvas disabled:opacity-50"
                                >
                                    {pending === u.handle ? '…' : 'Follow back'}
                                </button>
                            ) : undefined
                        }
                    />
                );
            })}
        </ul>
    );
}

function PersonRow({
    user,
    relationship,
    menuItems,
    disabled,
    trailing,
}: {
    user: FollowUser;
    relationship: string;
    menuItems: RowMenuItem[];
    disabled?: boolean;
    trailing?: React.ReactNode;
}) {
    const name = user.display_name || `@${user.handle}`;
    return (
        <li className={`flex items-center gap-3 py-3 ${disabled ? 'opacity-60' : ''}`}>
            <Avatar url={user.avatar_url} name={name} />
            <div className="min-w-0 flex-1">
                <Link
                    to={`/u/${user.handle}`}
                    className="block truncate text-sm font-medium text-ink hover:text-action"
                >
                    {name}
                    {user.is_verified_organizer && <VerifiedTick />}
                </Link>
                <div className="truncate text-xs text-ink-soft">@{user.handle}</div>
            </div>
            <span className="shrink-0 text-xs text-ink-soft">{relationship}</span>
            {trailing}
            <PersonRowMenu label={`Actions for ${name}`} items={menuItems} />
        </li>
    );
}

// --- Search results ---------------------------------------------------------

function SearchResults({
    term,
    loading,
    results,
    pending,
    onFollow,
    onClear,
}: {
    term: string;
    loading: boolean;
    results: UserSearchResult[] | null;
    pending: string | null;
    onFollow: (handle: string) => void;
    onClear: () => void;
}) {
    return (
        <div>
            <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-ink-soft">
                    Results for “<span className="text-ink">{term}</span>”
                </p>
                <button
                    type="button"
                    onClick={onClear}
                    className="text-xs font-medium text-action hover:underline"
                >
                    Clear
                </button>
            </div>
            {loading && results === null ? (
                <p className="text-xs text-muted">Searching…</p>
            ) : results && results.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-soft">No people found.</p>
            ) : (
                <ul className="divide-y divide-line">
                    {results?.map((u) => (
                        <li key={u.handle}>
                            <UserResultCard
                                user={u}
                                variant="rich"
                                href={`/u/${u.handle}`}
                                trailing={
                                    u.is_followed_by_viewer ? (
                                        <span className="text-xs text-ink-soft">Following</span>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                onFollow(u.handle);
                                            }}
                                            disabled={pending === u.handle}
                                            className="border border-line px-2.5 py-1 text-xs font-semibold text-action hover:bg-canvas disabled:opacity-50"
                                        >
                                            {pending === u.handle ? '…' : 'Follow'}
                                        </button>
                                    )
                                }
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// --- shared bits ------------------------------------------------------------

function Avatar({ url, name }: { url: string | null; name: string }) {
    if (url) {
        return (
            <img
                src={url}
                alt=""
                // eslint-disable-next-line no-restricted-syntax -- circular avatar
                className="h-11 w-11 shrink-0 rounded-full bg-slate-100 object-cover"
            />
        );
    }
    return (
        // eslint-disable-next-line no-restricted-syntax -- circular avatar placeholder
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-ink-soft">
            {name.trim().charAt(0).toUpperCase()}
        </div>
    );
}

function VerifiedTick() {
    return (
        <img
            src="/orga.png"
            alt=""
            title="Verified organizer"
            aria-label="Verified organizer"
            className="ml-1 inline-block h-3.5 w-3.5 align-middle object-contain"
        />
    );
}
