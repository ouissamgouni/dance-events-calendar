import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import {
    fetchProfilePassport,
    fetchPublicProfile,
    fetchUserCalendar,
    fetchUserHosting,
    fetchUserSuggested,
    followUser,
    setFollowNotify,
    unfollowUser,
    type ProfileCalendarItem,
    type ProfileCalendarList,
    type ProfileEventListResponse,
    type PublicProfile,
} from '../api';
import PassportView from '../components/PassportView';
import EventModal from '../components/EventModal';
import { isPlainClick } from '../utils/plainClick';
import type { CalendarEvent, SharedPassportResponse } from '../types';
import { reportMailto } from '../utils/report';

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
    const [searchParams, setSearchParams] = useSearchParams();
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

    // Email-driven "Follow" links use a `?follow=1` query param so the
    // suggestion rows in the activity digest email can trigger a follow
    // with a single click, reusing the authenticated follow API instead
    // of a signed-token GET action. Unauthenticated viewers are bounced
    // through login with `?next=` (the app's existing redirect-after-
    // login convention) and land back here with the param intact.
    useEffect(() => {
        if (searchParams.get('follow') !== '1' || !handle) return;
        if (!viewer) {
            const target = `/u/${handle}?follow=1`;
            navigate(`/login?next=${encodeURIComponent(target)}`, { replace: true });
            return;
        }
        if (!profile) return;
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.delete('follow');
                return next;
            },
            { replace: true },
        );
        const isPending = profile.follow_status === 'pending';
        if (!profile.is_following && !isPending) {
            handleFollowToggle();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams, handle, viewer, profile]);

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
            <div className="max-w-3xl mx-auto p-6 text-ink-soft">Loading…</div>
        );
    }

    if (error || !profile) {
        return (
            <div className="max-w-3xl mx-auto p-6">
                <div className="border border-line bg-canvas p-4 text-ink">
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
            {!profile.is_self && (
                <a
                    href={reportMailto('profile', `${window.location.origin}/u/${profile.handle}`, `@${profile.handle}`)}
                    className="block text-center text-xs text-ink-soft hover:text-ink"
                >
                    Report this profile
                </a>
            )}
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
        <div className="border border-line bg-surface px-4 py-4 sm:px-5">
            <div className="flex flex-col items-center gap-3 sm:gap-4">
                <div className="flex w-full items-end gap-4">
                    <Avatar
                        url={profile.avatar_url}
                        name={profile.display_name || profile.handle}
                    />
                    <div className="flex flex-1 justify-around sm:justify-start sm:gap-10 pb-2">
                        <div className="flex flex-col items-center sm:items-start">
                            <div className="text-lg font-semibold text-ink">{profile.followers_count}</div>
                            <div className="text-xs text-ink-soft">followers</div>
                        </div>
                        <div className="flex flex-col items-center sm:items-start">
                            <div className="text-lg font-semibold text-ink">{profile.following_count}</div>
                            <div className="text-xs text-ink-soft">following</div>
                        </div>
                        {!profile.is_self && profile.mutual_friend_count > 0 && (
                            <div className="flex flex-col items-center sm:items-start">
                                <div className="text-lg font-semibold text-ink">{profile.mutual_friend_count}</div>
                                <div className="text-xs text-ink-soft">mutual friend{profile.mutual_friend_count === 1 ? '' : 's'}</div>
                            </div>
                        )}
                    </div>
                </div>
                <div className="w-full text-left">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h1 className="text-lg font-semibold leading-tight text-ink sm:text-xl">
                            {profile.display_name || `@${profile.handle}`}
                        </h1>
                        {profile.is_verified_organizer && (
                            <VerifiedBadge />
                        )}
                        {profile.is_admin_managed && (
                            <CuratorBadge />
                        )}
                    </div>
                    <div className="mt-0.5 text-sm leading-tight text-ink-soft">
                        @{profile.handle} · <span className="whitespace-nowrap text-muted">Joined {memberSince}</span>
                    </div>
                </div>
                {profile.bio && (
                    <p className="w-full mt-2 text-sm text-ink whitespace-pre-line break-words">
                        {profile.bio}
                    </p>
                )}
                {!profile.is_self && profile.mutual_subscribers_count > 0 && (
                    <div className="w-full">
                        <MutualSubscribersLine
                            previews={profile.mutual_subscribers}
                            total={profile.mutual_subscribers_count}
                        />
                    </div>
                )}
                {profile.is_self ? (
                    <Link
                        to="/account"
                        className="w-full border border-line bg-surface px-3.5 py-1.5 text-sm font-medium text-ink text-center transition hover:bg-canvas"
                    >
                        Edit profile
                    </Link>
                ) : (
                    <div className="flex w-full items-stretch gap-1 sm:max-w-xs">
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
    const baseCls = 'flex-1 px-3.5 py-1.5 text-sm font-medium transition disabled:opacity-50';
    const cls = primary
        ? `${baseCls} bg-action text-white hover:bg-action`
        : `${baseCls} border border-line bg-surface text-ink hover:bg-canvas`;
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
        ? 'shrink-0 px-2 border border-line bg-surface text-action hover:bg-canvas transition disabled:opacity-50 flex items-center justify-center'
        : 'shrink-0 px-2 border border-line bg-surface text-muted hover:bg-canvas transition disabled:opacity-50 flex items-center justify-center';
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
            className="inline-flex items-center gap-1 bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-action"
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
            className="inline-flex items-center gap-1 bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-action"
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
                className="h-20 w-20 rounded-full bg-slate-100 object-cover"
            />
        );
    }
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    return (
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-200 text-2xl font-semibold text-ink-soft">
            {initial}
        </div>
    );
}

function SocialLinks({ profile }: { profile: PublicProfile }) {
    if (!profile.instagram_url && !profile.facebook_url) return null;
    return (
        <div className="border border-line bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-ink-soft mb-2">
                Links
            </div>
            <div className="flex flex-wrap gap-2">
                {profile.instagram_url && (
                    <a
                        href={profile.instagram_url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-sm text-action hover:underline"
                    >
                        Instagram
                    </a>
                )}
                {profile.facebook_url && (
                    <a
                        href={profile.facebook_url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-sm text-action hover:underline"
                    >
                        Facebook
                    </a>
                )}
            </div>
            <p className="mt-2 text-xs text-ink-soft">
                Links added by the user. Not verified by Movida.
            </p>
        </div>
    );
}

type TabKey = 'hosting' | 'calendar' | 'suggested' | 'passport';
const TAB_LABELS: Record<TabKey, string> = {
    hosting: 'Hosting',
    calendar: 'Calendar',
    suggested: 'Suggested',
    passport: 'Dance Passport',
};

type CalendarChip = 'all' | 'going' | 'saved';
const CALENDAR_CHIP_LABELS: Record<CalendarChip, string> = {
    all: 'All',
    going: 'Going',
    saved: 'Saved',
};

function ProfileTabs({ profile }: { profile: PublicProfile }) {
    const { organizerClaimsEnabled } = useOptionalFeatureFlags();
    const showHosting = organizerClaimsEnabled && profile.is_verified_organizer;
    const [active, setActive] = useState<TabKey>(showHosting ? 'hosting' : 'passport');
    // "Dance Passport" leads and is always present; its own visibility is
    // governed by ``passport_visibility`` (surfaced as ``can_view_passport``),
    // independent of the account-level gate on Calendar. Suggested is public.
    // Organizers lead with the events they host.
    const tabs: TabKey[] = showHosting
        ? ['hosting', 'passport', 'calendar', 'suggested']
        : ['passport', 'calendar', 'suggested'];

    // Account-level gate ("public" | "friends") controls the owner-activity
    // tabs. Suggested is always public. The passport tab has its own gate
    // (``can_view_passport``) handled below.
    const canSeeAccount =
        profile.is_self ||
        active === 'suggested' ||
        profile.account_visibility === 'public' ||
        (profile.account_visibility === 'friends' && profile.is_friend);

    let content: React.ReactNode;
    if (active === 'passport') {
        content = profile.can_view_passport ? (
            <PassportTabContent handle={profile.handle} />
        ) : (
            <PassportTabPlaceholder
                visibility={profile.passport_visibility ?? 'friends'}
            />
        );
    } else if (!canSeeAccount) {
        content = <PrivateTabPlaceholder visibility={profile.account_visibility} />;
    } else {
        content = <ProfileTabContent handle={profile.handle} tab={active} />;
    }

    return (
        <div className="border border-line bg-surface">
            <div className="flex border-b border-line">
                {tabs.map((k) => (
                    <button
                        key={k}
                        type="button"
                        onClick={() => setActive(k)}
                        className={
                            'px-4 py-3 text-sm font-medium transition ' +
                            (active === k
                                ? 'text-action border-b-2 border-action'
                                : 'text-ink-soft hover:text-ink')
                        }
                    >
                        {TAB_LABELS[k]}
                    </button>
                ))}
            </div>
            <div className="p-4">{content}</div>
        </div>
    );
}

function ProfileTabContent({ handle, tab }: { handle: string; tab: TabKey }) {
    if (tab === 'hosting') return <HostingTabContent handle={handle} />;
    if (tab === 'calendar') return <CalendarTabContent handle={handle} />;
    if (tab === 'passport') return <PassportTabContent handle={handle} />;
    return <SuggestedTabContent handle={handle} />;
}

function HostingTabContent({ handle }: { handle: string }) {
    const [includePast, setIncludePast] = useState(false);
    const [data, setData] = useState<ProfileEventListResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- per-tab fetch lifecycle
        setLoading(true);
        setError(null);
        fetchUserHosting(handle, { limit: 50, includePast })
            .then((res) => { if (!cancelled) setData(res); })
            .catch((err: unknown) => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [handle, includePast]);

    const items = data?.items ?? [];
    return (
        <div>
            <label className="mb-2 flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" checked={includePast} onChange={(e) => setIncludePast(e.target.checked)} />
                Include past events
            </label>
            {loading && !data ? (
                <div className="text-sm text-ink-soft p-2">Loading…</div>
            ) : error ? (
                <div className="text-sm text-ink-soft p-2">{error}</div>
            ) : items.length === 0 ? (
                <EmptyTabState tab="hosting" />
            ) : (
                <ul className="divide-y divide-slate-100">
                    {items.map((ev) => (
                        <ProfileEventRow key={ev.event_id} event={ev} />
                    ))}
                </ul>
            )}
        </div>
    );
}

function PassportTabContent({ handle }: { handle: string }) {
    const { user: viewer } = useAuth();
    const memoriesEnabled = Boolean(useOptionalFeatureFlags().eventMemoriesEnabled);
    const [data, setData] = useState<SharedPassportResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- per-tab fetch lifecycle
        setLoading(true);
        setError(null);
        fetchProfilePassport(handle)
            .then((res) => { if (!cancelled) setData(res); })
            .catch((err: unknown) => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [handle]);

    if (loading && !data) return <div className="text-sm text-ink-soft p-2">Loading…</div>;
    if (error) return <div className="text-sm text-ink-soft p-2">{error}</div>;
    if (!data) return null;
    return (
        <PassportView
            data={data}
            displayName={data.display_name ?? handle}
            handle={data.handle ?? handle}
            avatarUrl={data.avatar_url}
            sections={data.sections}
            timelineItems={data.timeline_items}
            timelineMarkers={data.timeline_markers}
            mapEvents={data.events}
            timelineMemoriesOwner={viewer && memoriesEnabled && !data.is_self && data.is_following ? data.handle ?? handle : null}
        />
    );
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

    if (loading && !data) return <div className="text-sm text-ink-soft p-2">Loading…</div>;
    if (error) return <div className="text-sm text-ink-soft p-2">{error}</div>;
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

    if (loading && !data) return <div className="text-sm text-ink-soft p-2">Loading…</div>;
    if (error) return <div className="text-sm text-ink-soft p-2">{error}</div>;

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
                                ? 'border-action bg-blue-50 text-action'
                                : 'border-line bg-surface text-ink-soft hover:bg-canvas')
                        }
                        aria-pressed={chip === c}
                    >
                        {CALENDAR_CHIP_LABELS[c]}
                    </button>
                ))}
                <label className="ml-auto flex items-center gap-2 text-xs text-ink-soft select-none">
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
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const badge =
        item.intent === 'both'
            ? { label: 'Going · Saved', cls: 'bg-blue-50 text-action' }
            : item.intent === 'going'
                ? { label: 'Going', cls: 'bg-emerald-50 text-success' }
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
                    onClick={(e) => {
                        if (!isPlainClick(e)) return;
                        e.preventDefault();
                        setOpen(true);
                    }}
                    className="block text-sm font-medium text-ink hover:text-action truncate"
                >
                    {item.event.title}
                </Link>
                <div className="flex items-center gap-1 shrink-0">
                    {item.curated && (
                        <span
                            className="px-2 py-0.5 text-xs font-medium bg-indigo-50 text-indigo-700"
                            title="Curated by the editorial team"
                        >
                            Curated
                        </span>
                    )}
                    <span className={`px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                        {badge.label}
                    </span>
                </div>
            </div>
            <p className="text-xs text-ink-soft">
                {dateLabel}
                {item.event.location ? ` · ${item.event.location}` : ''}
            </p>
            {open && <EventModal event={item.event} onClose={close} source="profile" />}
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
    return <p className="text-sm text-ink-soft p-2">{message}</p>;
}

function ProfileEventRow({ event }: { event: CalendarEvent }) {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
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
                onClick={(e) => {
                    if (!isPlainClick(e)) return;
                    e.preventDefault();
                    setOpen(true);
                }}
                className="block text-sm font-medium text-ink hover:text-action truncate"
            >
                {event.title}
            </Link>
            <p className="text-xs text-ink-soft">
                {dateLabel}
                {event.location ? ` · ${event.location}` : ''}
            </p>
            {open && <EventModal event={event} onClose={close} source="profile" />}
        </li>
    );
}

function EmptyTabState({ tab }: { tab: TabKey }) {
    const message =
        tab === 'hosting'
            ? 'No upcoming events hosted yet.'
            : tab === 'calendar'
                ? 'No events on this calendar yet.'
                : 'No approved suggestions yet.';
    return <p className="text-sm text-ink-soft p-2">{message}</p>;
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
        <p className="mt-2 text-xs text-ink-soft">
            Followed by{' '}
            {named.map((u, i) => (
                <span key={u.handle}>
                    {i > 0 ? (i === named.length - 1 && remaining === 0 ? ' and ' : ', ') : ''}
                    <Link
                        to={`/u/${u.handle}`}
                        className="text-ink hover:text-action"
                    >
                        {u.display_name || `@${u.handle}`}
                    </Link>
                </span>
            ))}
            {remaining > 0 && (
                <>
                    {' and '}
                    <span className="text-ink">
                        {remaining} other{remaining === 1 ? '' : 's'}
                    </span>
                </>
            )}{' '}
            you follow.
        </p>
    );
}

function PassportTabPlaceholder({ visibility }: { visibility: string }) {
    const message =
        visibility === 'private'
            ? 'This dancer keeps their Dance Passport private.'
            : 'This dancer shares their Dance Passport with friends only. Follow each other to view.';
    return (
        <div className="text-ink-soft">
            <div className="inline-flex items-center gap-2 text-ink-soft">
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                        fillRule="evenodd"
                        d="M10 1a4 4 0 0 0-4 4v3H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4Zm-2 7V5a2 2 0 1 1 4 0v3H8Z"
                        clipRule="evenodd"
                    />
                </svg>
                <span>{message}</span>
            </div>
        </div>
    );
}

function PrivateTabPlaceholder({ visibility }: { visibility: 'friends' | 'public' }) {
    const message =
        visibility === 'friends'
            ? 'Only this user’s friends can see this. Follow each other to view.'
            : 'This user keeps this private.';
    return (
        <div className="text-ink-soft">
            <div className="inline-flex items-center gap-2 text-ink-soft">
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
                <Link to="/" className="text-action hover:underline text-sm">
                    ← Back to events
                </Link>
            </div>
        </div>
    );
}
