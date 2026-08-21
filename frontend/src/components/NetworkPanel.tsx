import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    fetchFriendsLeaderboard,
    fetchMyFollowers,
    fetchMyFollowing,
    fetchMyFriends,
    followUser,
    removeMyFollower,
    unfollowUser,
    type FollowList,
    type FollowUser,
    type FriendsLeaderboardResponse,
    type LeaderboardPeriod,
} from '../api';
import FollowRequestsPanel from './FollowRequestsPanel';
import { ConfirmDialog } from './AppDialog';
/**
 * Network panel for the /account page. Lets the signed-in user browse
 * who follows them, who they follow, and the intersection (mutual = friends).
 *
 * Each tab is fetched lazily on first activation. The "Friends" tab
 * answers the user-facing question "how do I know who my friends are?"
 * since friendship is the mutual-follow gate used by the friends/private
 * audience tiers across the app.
 */

type Tab = 'followers' | 'following' | 'friends' | 'leaderboard';

const TAB_LABELS: Record<Tab, string> = {
    followers: 'Followers',
    following: 'Following',
    friends: 'Friends',
    leaderboard: 'Most active',
};

export default function NetworkPanel() {
    const [tab, setTab] = useState<Tab>('followers');
    const handleTabClick = useCallback((t: Tab) => {
        setTab(t);
    }, []);
    const [data, setData] = useState<Record<Exclude<Tab, 'leaderboard'>, FollowList | null>>({
        friends: null,
        followers: null,
        following: null,
    });
    const [errors, setErrors] = useState<Record<Tab, string | null>>({
        friends: null,
        followers: null,
        following: null,
        leaderboard: null,
    });
    // Phase E (E9): leaderboard state lives separately because its row
    // shape (rank + going_count) differs from the FollowUser tabs.
    const [leaderboardPeriod, setLeaderboardPeriod] = useState<LeaderboardPeriod>('30d');
    const [leaderboard, setLeaderboard] = useState<FriendsLeaderboardResponse | null>(null);

    // Tab-badge counts, fetched separately (limit: 1) from the full lists
    // in `data` so an eager count fetch never poisons `data[tab]` with a
    // truncated 1-item list that the full-list effect below then mistakes
    // for "already loaded" and skips re-fetching.
    const [counts, setCounts] = useState<Record<Exclude<Tab, 'leaderboard'>, number | null>>({
        friends: null,
        followers: null,
        following: null,
    });

    // E1: when a Follow action happens elsewhere (e.g. "Follow back" in
    // the notifications panel) invalidate cached lists so this panel
    // reflects the new edge on next render.
    useEffect(() => {
        const onChanged = () => {
            setData({ friends: null, followers: null, following: null });
            setLeaderboard(null);
        };
        window.addEventListener('network:changed', onChanged);
        return () => window.removeEventListener('network:changed', onChanged);
    }, []);

    // Eagerly fetch counts for all tabs on mount so counts are visible
    // before user clicks a tab. Fetch with limit: 1 just to get the total.
    useEffect(() => {
        let cancelled = false;
        const fetchCounts = async () => {
            try {
                const [friendsRes, followersRes, followingRes] = await Promise.all([
                    fetchMyFriends({ limit: 1 }),
                    fetchMyFollowers({ limit: 1 }),
                    fetchMyFollowing({ limit: 1 }),
                ]);
                if (!cancelled) {
                    setCounts({
                        friends: friendsRes.total,
                        followers: followersRes.total,
                        following: followingRes.total,
                    });
                }
            } catch (err) {
                // Errors on initial count fetch are non-fatal
                if (!cancelled) {
                    console.error('Failed to fetch network counts:', err);
                }
            }
        };
        fetchCounts();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (tab === 'leaderboard') {
            if (leaderboard !== null && leaderboard.period === leaderboardPeriod) return;
            let cancelled = false;
            fetchFriendsLeaderboard({ period: leaderboardPeriod, limit: 10 })
                .then((res) => {
                    if (!cancelled) setLeaderboard(res);
                })
                .catch((err) => {
                    if (!cancelled)
                        setErrors((e) => ({
                            ...e,
                            leaderboard: err instanceof Error ? err.message : 'Failed to load',
                        }));
                });
            return () => {
                cancelled = true;
            };
        }
        // If data already has items (full list), don't re-fetch
        if (data[tab] !== null && data[tab].items.length > 0) return;
        let cancelled = false;
        const fetcher =
            tab === 'friends'
                ? fetchMyFriends
                : tab === 'followers'
                    ? fetchMyFollowers
                    : fetchMyFollowing;
        fetcher({ limit: 50 })
            .then((res) => {
                if (!cancelled) setData((d) => ({ ...d, [tab]: res }));
            })
            .catch((err) => {
                if (!cancelled)
                    setErrors((e) => ({
                        ...e,
                        [tab]: err instanceof Error ? err.message : 'Failed to load',
                    }));
            });
        return () => {
            cancelled = true;
        };
    }, [tab, data, leaderboard, leaderboardPeriod]);

    const current = tab === 'leaderboard' ? null : data[tab];
    const error = errors[tab];
    const [pending, setPending] = useState<string | null>(null);
    const [removeTarget, setRemoveTarget] = useState<FollowUser | null>(null);

    async function handleRemove(target: FollowUser) {
        if (pending) return;
        setRemoveTarget(target);
    }

    async function confirmRemove() {
        const target = removeTarget;
        if (!target || pending) return;
        setRemoveTarget(null);
        const action = tab === 'followers' ? 'remove' : 'unfollow';
        setPending(target.handle);
        try {
            if (action === 'remove') {
                await removeMyFollower(target.handle);
            } else {
                await unfollowUser(target.handle);
            }
            // Invalidate all tabs that may now be stale (a remove/unfollow
            // also affects the friends intersection).
            setData({ friends: null, followers: null, following: null });
            // Tell AuthContext + other panels that the graph changed so
            // friend_count-driven UI (AudiencePicker hint) refreshes.
            window.dispatchEvent(new Event('network:changed'));
        } catch (err) {
            setErrors((e) => ({
                ...e,
                [tab]: err instanceof Error ? err.message : `Failed to ${action}`,
            }));
        } finally {
            setPending(null);
        }
    }

    // Phase E (E1 follow-up): "Follow back" button on the Followers tab
    // for users who follow viewer but viewer doesn't follow back yet
    // (i.e. ``is_friend === false`` on a row in the followers list).
    async function handleFollowBack(target: FollowUser) {
        if (pending) return;
        setPending(target.handle);
        try {
            await followUser(target.handle);
            // The new edge promotes this row to a friend; refetch to flip
            // the button and surface the row in the Friends tab.
            setData({ friends: null, followers: null, following: null });
            window.dispatchEvent(new Event('network:changed'));
        } catch (err) {
            setErrors((e) => ({
                ...e,
                [tab]: err instanceof Error ? err.message : 'Failed to follow',
            }));
        } finally {
            setPending(null);
        }
    }

    const removeVerb = tab === 'followers' ? 'Remove' : 'Unfollow';
    const removeName = removeTarget?.display_name || (removeTarget ? `@${removeTarget.handle}` : 'this user');

    return (
        <section
            id="network"
            className="border border-line bg-surface p-4 mb-3 scroll-mt-4"
        >
            <FollowRequestsPanel />
            <div
                role="tablist"
                aria-label="My network"
                className="flex gap-0.5 mb-3 border-b border-line overflow-x-auto scrollbar-none"
            >
                {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
                    const active = t === tab;
                    const count =
                        t === 'leaderboard' ? undefined : data[t]?.total ?? counts[t] ?? undefined;
                    return (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => handleTabClick(t)}
                            className={`shrink-0 px-2.5 py-1.5 text-xs font-medium border-b-2 -mb-px whitespace-nowrap ${active
                                ? 'border-action text-action'
                                : 'border-transparent text-ink-soft hover:text-ink'
                                }`}
                        >
                            {TAB_LABELS[t]}
                            {typeof count === 'number' && (
                                <span className="ml-1 text-xs text-muted">
                                    {count}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            <div className="max-h-80 overflow-y-auto">
                {error ? (
                    <p className="text-xs text-danger">{error}</p>
                ) : tab === 'leaderboard' ? (
                    <LeaderboardView
                        period={leaderboardPeriod}
                        onPeriodChange={(p) => {
                            setLeaderboardPeriod(p);
                            setLeaderboard(null);
                        }}
                        data={leaderboard}
                    />
                ) : current === null ? (
                    <p className="text-xs text-muted">Loading…</p>
                ) : current.items.length === 0 ? (
                    <p className="text-xs text-ink-soft">
                        {tab === 'friends'
                            ? "You don't have any friends yet. Friends are users who follow you back."
                            : tab === 'followers'
                                ? 'No one is following you yet.'
                                : "You aren't following anyone yet."}
                    </p>
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {current.items.map((u: FollowUser) => {
                            const name = u.display_name || `@${u.handle}`;
                            const initial = name.trim().charAt(0).toUpperCase();
                            return (
                                <li
                                    key={u.handle}
                                    className="flex items-center gap-3 py-2"
                                >
                                    {u.avatar_url ? (
                                        <img
                                            src={u.avatar_url}
                                            alt=""
                                            className="w-8 h-8 rounded-full object-cover bg-slate-100"
                                        />
                                    ) : (
                                        <div className="w-8 h-8 rounded-full bg-slate-200 text-ink-soft flex items-center justify-center text-xs font-semibold">
                                            {initial}
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <Link
                                            to={`/u/${u.handle}`}
                                            className="block truncate text-xs font-medium text-ink hover:text-action"
                                        >
                                            {name}
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
                                        <div className="text-xs text-ink-soft truncate">
                                            @{u.handle}
                                            {u.is_friend && tab !== 'friends' && (
                                                <span className="ml-1.5 text-success">
                                                    · friend
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    {tab !== 'friends' && (
                                        <div className="flex items-center gap-2 shrink-0">
                                            {tab === 'followers' && !u.is_friend && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleFollowBack(u)}
                                                    disabled={pending === u.handle}
                                                    className="shrink-0 bg-action px-2.5 py-1 text-xs font-semibold text-white hover:bg-action disabled:opacity-50"
                                                >
                                                    {pending === u.handle ? '…' : 'Follow back'}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => handleRemove(u)}
                                                disabled={pending === u.handle}
                                                className="shrink-0 border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50"
                                            >
                                                {pending === u.handle
                                                    ? '…'
                                                    : tab === 'followers'
                                                        ? 'Remove'
                                                        : 'Unfollow'}
                                            </button>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
            <ConfirmDialog
                open={removeTarget !== null}
                title={`${removeVerb} User`}
                message={`${removeVerb} ${removeName}?`}
                confirmLabel={removeVerb}
                onCancel={() => setRemoveTarget(null)}
                onConfirm={() => void confirmRemove()}
            />
        </section>
    );
}

const PERIOD_LABEL: Record<LeaderboardPeriod, string> = {
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
};

function LeaderboardView({
    period,
    onPeriodChange,
    data,
}: {
    period: LeaderboardPeriod;
    onPeriodChange: (next: LeaderboardPeriod) => void;
    data: FriendsLeaderboardResponse | null;
}) {
    return (
        <div data-testid="friends-leaderboard">
            <div
                role="radiogroup"
                aria-label="Leaderboard period"
                className="inline-flex border border-line mb-3"
            >
                {(Object.keys(PERIOD_LABEL) as LeaderboardPeriod[]).map((p) => {
                    const active = p === period;
                    return (
                        <button
                            key={p}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => onPeriodChange(p)}
                            className={
                                'px-2.5 py-1 text-xs font-medium border-l first:border-l-0 border-line ' +
                                (active
                                    ? 'bg-action text-white'
                                    : 'bg-surface text-ink-soft hover:bg-canvas')
                            }
                        >
                            {PERIOD_LABEL[p]}
                        </button>
                    );
                })}
            </div>
            {data === null ? (
                <p className="text-sm text-muted">Loading…</p>
            ) : data.items.length === 0 ? (
                <p className="text-sm text-ink-soft">
                    No Going activity from your friends in this window.
                </p>
            ) : (
                <ol className="divide-y divide-slate-100">
                    {data.items.map((row) => {
                        const name = row.display_name || `@${row.handle}`;
                        const initial = name.trim().charAt(0).toUpperCase();
                        return (
                            <li
                                key={row.handle}
                                className="flex items-center gap-3 py-2"
                            >
                                <span className="w-6 text-right text-xs font-semibold text-ink-soft">
                                    {row.rank}
                                </span>
                                {row.avatar_url ? (
                                    <img
                                        src={row.avatar_url}
                                        alt=""
                                        className="w-8 h-8 rounded-full object-cover bg-slate-100"
                                    />
                                ) : (
                                    <div className="w-8 h-8 rounded-full bg-slate-200 text-ink-soft flex items-center justify-center text-xs font-semibold">
                                        {initial}
                                    </div>
                                )}
                                <Link
                                    to={`/u/${row.handle}`}
                                    className="flex-1 truncate text-xs font-medium text-ink hover:text-action"
                                >
                                    {name}
                                    {row.is_verified_organizer && (
                                        <img
                                            src="/orga.png"
                                            alt=""
                                            title="Verified organizer"
                                            aria-label="Verified organizer"
                                            className="inline-block w-3.5 h-3.5 ml-1 align-middle object-contain"
                                        />
                                    )}
                                </Link>
                                <span className="shrink-0 text-xs text-ink-soft">
                                    {row.going_count} going
                                </span>
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
}
