import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
    fetchPublicProfile,
    fetchUserCalendar,
    fetchUserSuggested,
    followUser,
    setFollowNotify,
    unfollowUser,
    type ProfileCalendarItem,
    type ProfileCalendarList,
    type ProfileEventListResponse,
    type PublicProfile,
} from '../api';
import type { CalendarEvent } from '../types';

/**
 * Public profile page at /u/{handle}.
 *
 * Privacy notes:
 * - Email is never displayed (and never returned by the API).
 * - Per-scope visibility values are echoed by the API so we can render a
 *   "Private" placeholder for tabs the viewer is not allowed to see, without
 *   leaking counts or items.
 * - Mutual-friend count acts as an organic credibility signal alongside the
 *   admin-granted "Verified organizer" badge.
 *
 * Tabs (Going / Saved / Calendar) currently render a placeholder; the data
 * endpoints they will consume land in Phase B alongside the friend filter
 * and calendar subscriptions.
 */
export default function ProfilePage() {
    const { handle } = useParams<{ handle: string }>();
    const { user: viewer } = useAuth();
    const navigate = useNavigate();
    const [profile, setProfile] = useState<PublicProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [followBusy, setFollowBusy] = useState(false);
    const [notifyBusy, setNotifyBusy] = useState(false);

    const load = useCallback(async () => {
        if (!handle) return;
        setLoading(true);
        setError(null);
        try {
            const p = await fetchPublicProfile(handle);
            setProfile(p);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load profile');
        } finally {
            setLoading(false);
        }
    }, [handle]);

    useEffect(() => {
        load();
    }, [load]);

    const handleFollowToggle = async () => {
        if (!profile) return;
        if (!viewer) {
            navigate('/login', { state: { redirectTo: `/u/${profile.handle}` } });
            return;
        }
        setFollowBusy(true);
        try {
            // Phase E (E8): treat pending follow-requests the same as an
            // active follow for the purposes of the toggle — DELETE
            // rescinds the request.
            const isPending = profile.follow_status === 'pending';
            const result = profile.is_following || isPending
                ? await unfollowUser(profile.handle)
                : await followUser(profile.handle);
            // Phase B: follow auto-creates a calendar subscription (with
            // notify_new_events=true), and unfollow drops it. Reflect the
            // implied subscriber count so the header stat updates without
            // a refetch.
            const subDelta =
                (result.is_subscribed ? 1 : 0) - (profile.is_subscribed ? 1 : 0);
            setProfile({
                ...profile,
                is_following: result.is_following,
                is_friend: result.is_friend,
                followers_count: result.followers_count,
                is_subscribed: result.is_subscribed,
                notify_new_events: result.notify_new_events,
                // Phase E (E8): persist the pending state so the button
                // renders "Requested" until the target approves or the
                // viewer rescinds.
                follow_status: result.follow_status ?? 'approved',
                subscribers_count: Math.max(0, profile.subscribers_count + subDelta),
            });
            // Phase E: notify Auth + Network panels that the graph changed
            // so friend_count-driven UI (AudiencePicker hint) refreshes.
            window.dispatchEvent(new Event('network:changed'));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Action failed');
        } finally {
            setFollowBusy(false);
        }
    };

    const handleNotifyToggle = async (next: boolean) => {
        if (!profile || !profile.is_subscribed) return;
        // Optimistic update; PATCH /follow/notify is the single source of
        // truth for the bell state on a Following relationship.
        const previous = profile.notify_new_events;
        setProfile({ ...profile, notify_new_events: next });
        setNotifyBusy(true);
        try {
            const result = await setFollowNotify(profile.handle, next);
            setProfile((prev) =>
                prev
                    ? { ...prev, notify_new_events: result.notify_new_events }
                    : prev,
            );
        } catch (err) {
            setProfile((prev) =>
                prev ? { ...prev, notify_new_events: previous } : prev,
            );
            setError(err instanceof Error ? err.message : 'Update failed');
        } finally {
            setNotifyBusy(false);
        }
    };

    if (loading) {
        return (
            <div className="max-w-3xl mx-auto p-6 text-slate-500">Loading…</div>
        );
    }

    if (error || !profile) {
        return (
            <div className="max-w-3xl mx-auto p-6">
                <div className="border border-slate-200 bg-slate-50 p-4 text-slate-700">
                    {error || 'User not found'}
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-3xl mx-auto p-6 space-y-6">
            <ProfileHeader
                profile={profile}
                onFollow={handleFollowToggle}
                followBusy={followBusy}
                onNotifyToggle={handleNotifyToggle}
                notifyBusy={notifyBusy}
                isAuthenticated={!!viewer}
            />
            <SocialLinks profile={profile} />
            <ProfileTabs profile={profile} />
        </div>
    );
}

function ProfileHeader({
    profile,
    onFollow,
    followBusy,
    onNotifyToggle,
    notifyBusy,
    isAuthenticated,
}: {
    profile: PublicProfile;
    onFollow: () => void;
    followBusy: boolean;
    onNotifyToggle: (next: boolean) => void;
    notifyBusy: boolean;
    isAuthenticated: boolean;
}) {
    const memberSince = new Date(profile.member_since).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
    });
    return (
        <div className="border border-slate-200 bg-white px-4 py-4 sm:px-5">
            <div className="flex min-w-0 items-start gap-3 sm:gap-4">
                <Avatar
                    url={profile.avatar_url}
                    name={profile.display_name || profile.handle}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h1 className="truncate text-lg font-semibold leading-tight text-slate-900 sm:text-xl">
                                    {profile.display_name || `@${profile.handle}`}
                                </h1>
                                {profile.is_verified_organizer && (
                                    <VerifiedBadge />
                                )}
                                {profile.is_admin_managed && (
                                    <CuratorBadge />
                                )}
                            </div>
                            <div className="mt-0.5 text-sm leading-tight text-slate-500">@{profile.handle}</div>
                        </div>
                        {!profile.is_self && (
                            <div className="flex shrink-0 items-stretch gap-1">
                                <FollowButton
                                    profile={profile}
                                    onClick={onFollow}
                                    busy={followBusy}
                                    isAuthenticated={isAuthenticated}
                                />
                                {/* Phase B: Follow implies calendar subscription.
                                    The bell toggle controls notify_new_events on
                                    that implied subscription — only meaningful
                                    while following. */}
                                {isAuthenticated && profile.is_following && profile.is_subscribed && (
                                    <NotifyBellToggle
                                        enabled={profile.notify_new_events}
                                        onChange={onNotifyToggle}
                                        busy={notifyBusy}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                        <span>
                            <strong className="text-slate-900">{profile.followers_count}</strong>{' '}
                            followers
                        </span>
                        <span>
                            <strong className="text-slate-900">{profile.following_count}</strong>{' '}
                            following
                        </span>
                        {!profile.is_self && profile.mutual_friend_count > 0 && (
                            <span>
                                <strong className="text-slate-900">
                                    {profile.mutual_friend_count}
                                </strong>{' '}
                                mutual friend{profile.mutual_friend_count === 1 ? '' : 's'}
                            </span>
                        )}
                        <span className="whitespace-nowrap text-slate-400">Joined {memberSince}</span>
                    </div>
                    {profile.bio && (
                        <p className="mt-2 text-sm text-slate-700 whitespace-pre-line break-words">
                            {profile.bio}
                        </p>
                    )}
                    {!profile.is_self && profile.mutual_subscribers_count > 0 && (
                        <MutualSubscribersLine
                            previews={profile.mutual_subscribers}
                            total={profile.mutual_subscribers_count}
                        />
                    )}
                    {/* Phase E (E10): trust pill on verified-organizer profiles
                        when any of the viewer's friends already follow them. */}
                    {profile.is_verified_organizer &&
                        !profile.is_self &&
                        (profile.mutual_friends_who_follow ?? 0) > 0 && (
                            <p
                                className="mt-1.5 inline-block border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700"
                                data-testid="mutual-friends-who-follow-pill"
                            >
                                Followed by{' '}
                                <strong className="text-slate-900">
                                    {profile.mutual_friends_who_follow}
                                </strong>{' '}
                                of your friend{profile.mutual_friends_who_follow === 1 ? '' : 's'}
                            </p>
                        )}
                    <FollowHintBanner profile={profile} isAuthenticated={isAuthenticated} />
                </div>
            </div>
        </div>
    );
}

/**
 * Small contextual hint shown under the Follow button explaining the
 * symmetric-follow semantics:
 *
 * - Not following / they don't follow you: "Follow them so they see you in their friends list"
 * - Not following / they follow you (back): "Follow them back — you'll appear in each other's friend lists"
 * - You follow / they don't follow you: "They haven't followed back yet — they won't see you as a friend"
 * - Mutual (already friends): nothing.
 */
function FollowHintBanner({
    profile,
    isAuthenticated,
}: {
    profile: PublicProfile;
    isAuthenticated: boolean;
}) {
    if (!isAuthenticated || profile.is_self || profile.is_friend) return null;
    let message: string;
    if (!profile.is_following && profile.follows_you) {
        message = "They follow you back — follow them so you appear in each other's friends list.";
    } else if (!profile.is_following) {
        message = "Follow them so they see you in their friends list.";
    } else {
        message = "They haven't followed back yet — they won't see you as a friend.";
    }
    return (
        <div className="text-xs text-slate-500 max-w-xs leading-snug">
            {message}
        </div>
    );
}

function FollowButton({
    profile,
    onClick,
    busy,
    isAuthenticated,
}: {
    profile: PublicProfile;
    onClick: () => void;
    busy: boolean;
    isAuthenticated: boolean;
}) {
    let label: string;
    let primary: boolean;
    if (!isAuthenticated) {
        label = 'Sign in to follow';
        primary = true;
    } else if (profile.is_friend) {
        label = 'Friends ✓';
        primary = false;
    } else if (profile.is_following) {
        label = 'Following';
        primary = false;
    } else if (profile.follow_status === 'pending') {
        // Phase E (E8): outstanding follow-request awaiting approval.
        // Clicking again rescinds the request (DELETE /follow).
        label = 'Requested';
        primary = false;
    } else if (profile.follows_you) {
        label = 'Follow back';
        primary = true;
    } else if (profile.account_visibility === 'friends') {
        // Phase E (E8): clarify that this action sends a request, not
        // an instant follow.
        label = 'Request to follow';
        primary = true;
    } else {
        label = 'Follow';
        primary = true;
    }
    const baseCls = 'shrink-0 px-3.5 py-1.5 text-sm font-medium transition disabled:opacity-50';
    const cls = primary
        ? `${baseCls} bg-blue-500 text-white hover:bg-blue-600`
        : `${baseCls} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`;
    return (
        <button type="button" className={cls} onClick={onClick} disabled={busy}>
            {label}
        </button>
    );
}

function NotifyBellToggle({
    enabled,
    onChange,
    busy,
}: {
    enabled: boolean;
    onChange: (next: boolean) => void;
    busy: boolean;
}) {
    const label = enabled
        ? 'Notifications on — click to mute'
        : 'Notifications muted — click to enable';
    const cls = enabled
        ? 'shrink-0 px-2 border border-slate-200 bg-white text-blue-500 hover:bg-slate-50 transition disabled:opacity-50 flex items-center justify-center'
        : 'shrink-0 px-2 border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 transition disabled:opacity-50 flex items-center justify-center';
    return (
        <button
            type="button"
            className={cls}
            onClick={() => onChange(!enabled)}
            disabled={busy}
            aria-label={label}
            title={label}
            aria-pressed={enabled}
        >
            {enabled ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M10 2a6 6 0 0 0-6 6v2.382l-1.447 2.894A1 1 0 0 0 3.447 15H7a3 3 0 0 0 6 0h3.553a1 1 0 0 0 .894-1.724L16 10.382V8a6 6 0 0 0-6-6Z" />
                </svg>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l14 14" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 8a5 5 0 0 1 8.5-3.5M15 8v2.4l1.6 3.2H8" />
                </svg>
            )}
        </button>
    );
}

function VerifiedBadge() {
    return (
        <span
            className="inline-flex items-center gap-1 bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-blue-700"
            title="Admin-verified organizer"
        >
            <img
                src="/orga.png"
                alt=""
                aria-hidden="true"
                className="w-3.5 h-3.5 object-contain"
            />
            Verified organizer
        </span>
    );
}

function CuratorBadge() {
    return (
        <span
            className="inline-flex items-center gap-1 bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-blue-700"
            title="Editorial curator"
        >
            <img
                src="/badge.png"
                alt=""
                aria-hidden="true"
                className="w-3.5 h-3.5 object-contain"
            />
            Curator
        </span>
    );
}

function Avatar({ url, name }: { url: string | null; name: string }) {
    if (url) {
        return (
            <img
                src={url}
                alt={name}
                className="h-14 w-14 rounded-full bg-slate-100 object-cover"
            />
        );
    }
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    return (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-200 text-lg font-semibold text-slate-600">
            {initial}
        </div>
    );
}

function SocialLinks({ profile }: { profile: PublicProfile }) {
    if (!profile.instagram_url && !profile.facebook_url) return null;
    return (
        <div className="border border-slate-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
                Links
            </div>
            <div className="flex flex-wrap gap-2">
                {profile.instagram_url && (
                    <a
                        href={profile.instagram_url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-sm text-blue-600 hover:underline"
                    >
                        Instagram
                    </a>
                )}
                {profile.facebook_url && (
                    <a
                        href={profile.facebook_url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-sm text-blue-600 hover:underline"
                    >
                        Facebook
                    </a>
                )}
            </div>
            <p className="mt-2 text-xs text-slate-400">
                Links added by the user. Not verified by Movida.
            </p>
        </div>
    );
}

type TabKey = 'calendar' | 'suggested';
const TAB_LABELS: Record<TabKey, string> = {
    calendar: 'Calendar',
    suggested: 'Suggested',
};

type CalendarChip = 'all' | 'going' | 'saved';
const CALENDAR_CHIP_LABELS: Record<CalendarChip, string> = {
    all: 'All',
    going: 'Going',
    saved: 'Saved',
};

function ProfileTabs({ profile }: { profile: PublicProfile }) {
    const [active, setActive] = useState<TabKey>('calendar');
    // Single account-level gate ("public" | "friends") now controls all
    // tabs that surface owner activity. Suggested is always public.
    const canSee =
        profile.is_self ||
        active === 'suggested' ||
        profile.account_visibility === 'public' ||
        (profile.account_visibility === 'friends' && profile.is_friend);

    return (
        <div className="border border-slate-200 bg-white">
            <div className="flex border-b border-slate-200">
                {(Object.keys(TAB_LABELS) as TabKey[]).map((k) => (
                    <button
                        key={k}
                        type="button"
                        onClick={() => setActive(k)}
                        className={
                            'px-4 py-3 text-sm font-medium transition ' +
                            (active === k
                                ? 'text-blue-600 border-b-2 border-blue-500'
                                : 'text-slate-500 hover:text-slate-700')
                        }
                    >
                        {TAB_LABELS[k]}
                    </button>
                ))}
            </div>
            <div className="p-4">
                {!canSee ? (
                    <PrivateTabPlaceholder visibility={profile.account_visibility} />
                ) : (
                    <ProfileTabContent handle={profile.handle} tab={active} />
                )}
            </div>
        </div>
    );
}

function ProfileTabContent({ handle, tab }: { handle: string; tab: TabKey }) {
    if (tab === 'calendar') return <CalendarTabContent handle={handle} />;
    return <SuggestedTabContent handle={handle} />;
}

function SuggestedTabContent({ handle }: { handle: string }) {
    const [data, setData] = useState<ProfileEventListResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- per-tab fetch lifecycle
        setLoading(true);
        setError(null);
        fetchUserSuggested(handle, { limit: 20 })
            .then((res) => { if (!cancelled) setData(res); })
            .catch((err: unknown) => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [handle]);

    if (loading && !data) return <div className="text-sm text-slate-500 p-2">Loading…</div>;
    if (error) return <div className="text-sm text-slate-500 p-2">{error}</div>;
    const items = data?.items ?? [];
    if (items.length === 0) return <EmptyTabState tab="suggested" />;
    return (
        <ul className="divide-y divide-slate-100">
            {items.map((ev) => (
                <ProfileEventRow key={ev.event_id} event={ev} />
            ))}
        </ul>
    );
}

function CalendarTabContent({ handle }: { handle: string }) {
    // Past-toggle is meaningful for the Going slice; Saved is forward-only by
    // design but the toggle still applies to the union for symmetry.
    const [includePast, setIncludePast] = useState(false);
    const [chip, setChip] = useState<CalendarChip>('all');
    const [data, setData] = useState<ProfileCalendarList | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- per-tab fetch lifecycle
        setLoading(true);
        setError(null);
        fetchUserCalendar(handle, { limit: 50, includePast })
            .then((res) => { if (!cancelled) setData(res); })
            .catch((err: unknown) => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [handle, includePast]);

    const items: ProfileCalendarItem[] = useMemo(() => {
        const all = data?.items ?? [];
        if (chip === 'all') return all;
        if (chip === 'going') return all.filter((it) => it.intent === 'going' || it.intent === 'both');
        return all.filter((it) => it.intent === 'saved' || it.intent === 'both');
    }, [data, chip]);

    if (loading && !data) return <div className="text-sm text-slate-500 p-2">Loading…</div>;
    if (error) return <div className="text-sm text-slate-500 p-2">{error}</div>;

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                {(Object.keys(CALENDAR_CHIP_LABELS) as CalendarChip[]).map((c) => (
                    <button
                        key={c}
                        type="button"
                        onClick={() => setChip(c)}
                        className={
                            'px-3 py-1 text-xs font-medium border transition ' +
                            (chip === c
                                ? 'border-blue-500 bg-blue-50 text-blue-700'
                                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')
                        }
                        aria-pressed={chip === c}
                    >
                        {CALENDAR_CHIP_LABELS[c]}
                    </button>
                ))}
                <label className="ml-auto flex items-center gap-2 text-xs text-slate-600 select-none">
                    <input
                        type="checkbox"
                        className="h-3.5 w-3.5"
                        checked={includePast}
                        onChange={(e) => setIncludePast(e.target.checked)}
                    />
                    Include past
                </label>
            </div>
            {items.length === 0 ? (
                <EmptyCalendarState chip={chip} />
            ) : (
                <ul className="divide-y divide-slate-100">
                    {items.map((it) => (
                        <ProfileCalendarRow key={it.event.event_id} item={it} />
                    ))}
                </ul>
            )}
        </div>
    );
}

function ProfileCalendarRow({ item }: { item: ProfileCalendarItem }) {
    const badge =
        item.intent === 'both'
            ? { label: 'Going · Saved', cls: 'bg-blue-50 text-blue-700' }
            : item.intent === 'going'
                ? { label: 'Going', cls: 'bg-emerald-50 text-emerald-700' }
                : { label: 'Saved', cls: 'bg-amber-50 text-amber-700' };
    const start = new Date(item.event.start);
    const dateLabel = start.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
    return (
        <li className="px-2 py-2">
            <div className="flex items-start justify-between gap-2">
                <Link
                    to={`/event/${item.event.event_id}`}
                    className="block text-sm font-medium text-slate-900 hover:text-blue-600 truncate"
                >
                    {item.event.title}
                </Link>
                <div className="flex items-center gap-1 shrink-0">
                    {item.curated && (
                        <span
                            className="px-2 py-0.5 text-[10px] font-medium bg-indigo-50 text-indigo-700"
                            title="Curated by the editorial team"
                        >
                            Curated
                        </span>
                    )}
                    <span className={`px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>
                        {badge.label}
                    </span>
                </div>
            </div>
            <p className="text-xs text-slate-500">
                {dateLabel}
                {item.event.location ? ` · ${item.event.location}` : ''}
            </p>
        </li>
    );
}

function EmptyCalendarState({ chip }: { chip: CalendarChip }) {
    const message =
        chip === 'going'
            ? 'No upcoming events on the going list.'
            : chip === 'saved'
                ? 'No saved events yet.'
                : 'No events on this calendar yet.';
    return <p className="text-sm text-slate-500 p-2">{message}</p>;
}

function ProfileEventRow({ event }: { event: CalendarEvent }) {
    const start = useMemo(() => new Date(event.start), [event.start]);
    const dateLabel = start.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
    return (
        <li className="px-2 py-2">
            <Link
                to={`/event/${event.event_id}`}
                className="block text-sm font-medium text-slate-900 hover:text-blue-600 truncate"
            >
                {event.title}
            </Link>
            <p className="text-xs text-slate-500">
                {dateLabel}
                {event.location ? ` · ${event.location}` : ''}
            </p>
        </li>
    );
}

function EmptyTabState({ tab }: { tab: TabKey }) {
    const message =
        tab === 'calendar'
            ? 'No events on this calendar yet.'
            : 'No approved suggestions yet.';
    return <p className="text-sm text-slate-500 p-2">{message}</p>;
}

function MutualSubscribersLine({
    previews,
    total,
}: {
    previews: PublicProfile['mutual_subscribers'];
    total: number;
}) {
    if (total <= 0) return null;
    const named = previews.slice(0, 3);
    const remaining = Math.max(0, total - named.length);
    return (
        <p className="mt-2 text-xs text-slate-500">
            Subscribed to by{' '}
            {named.map((u, i) => (
                <span key={u.handle}>
                    {i > 0 ? (i === named.length - 1 && remaining === 0 ? ' and ' : ', ') : ''}
                    <Link
                        to={`/u/${u.handle}`}
                        className="text-slate-700 hover:text-blue-600"
                    >
                        {u.display_name || `@${u.handle}`}
                    </Link>
                </span>
            ))}
            {remaining > 0 && (
                <>
                    {' and '}
                    <span className="text-slate-700">
                        {remaining} other{remaining === 1 ? '' : 's'}
                    </span>
                </>
            )}{' '}
            you know.
        </p>
    );
}

function PrivateTabPlaceholder({ visibility }: { visibility: 'friends' | 'public' }) {
    const message =
        visibility === 'friends'
            ? 'Only this user’s friends can see this. Follow each other to view.'
            : 'This user keeps this private.';
    return (
        <div className="text-slate-500">
            <div className="inline-flex items-center gap-2 text-slate-600">
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                        fillRule="evenodd"
                        d="M10 1a4 4 0 0 0-4 4v3H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4Zm-2 7V5a2 2 0 1 1 4 0v3H8Z"
                        clipRule="evenodd"
                    />
                </svg>
                <span>{message}</span>
            </div>
            <div className="mt-3">
                <Link to="/" className="text-blue-600 hover:underline text-sm">
                    ← Back to events
                </Link>
            </div>
        </div>
    );
}
