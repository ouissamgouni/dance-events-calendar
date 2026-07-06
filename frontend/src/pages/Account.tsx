import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import {
    checkHandleAvailable,
    fetchMyRatings,
    updateUserProfile,
    fetchEventsByIds,
} from '../api';
import type { MyRating, CalendarEvent } from '../types';
import PreferencesSection from '../components/PreferencesSection';
import VisibilitySection, { ProfileLinksEditor } from '../components/VisibilitySection';
import NotificationSettings from '../components/NotificationSettings';
import PushNotificationSettings from '../components/PushNotificationSettings';
import InstallAppSection from '../components/InstallAppSection';
import BioEditor from '../components/BioEditor';
import NetworkPanel from '../components/NetworkPanel';
import ReferralCard from '../components/ReferralCard';
import OrganizerClaimSection from '../components/OrganizerClaimSection';
import YourNextEventsRail from '../components/YourNextEventsRail';
import EventModal from '../components/EventModal';
import { trackView } from '../utils/tracking';

function slugifyHandle(name: string): string {
    const base = name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24);
    if (!base) return '';
    // Must start with a letter per server validation.
    return /^[a-z]/.test(base) ? base : `u_${base}`.slice(0, 24);
}

export default function Account() {
    const { user, loading, logout, deleteAccount, refreshUser } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const { savedEventIds, savedCount } = useSavedEvents();
    const { attendingEventIds, attendingCount } = useAttendingEvents();
    const { showRatings, organizerClaimsEnabled } = useFeatureFlags();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [myRatings, setMyRatings] = useState<MyRating[] | null>(null);
    const [myEvents, setMyEvents] = useState<CalendarEvent[]>([]);
    const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

    // --- Profile editing (display_name + handle) ---
    const [profileEditing, setProfileEditing] = useState(false);
    const [nameDraft, setNameDraft] = useState<string>(user?.name ?? '');
    const [handleDraft, setHandleDraft] = useState<string>(user?.handle ?? '');
    const [profileSaving, setProfileSaving] = useState(false);
    const [profileError, setProfileError] = useState<string | null>(null);
    const [handleStatus, setHandleStatus] = useState<
        | { state: 'idle' }
        | { state: 'checking' }
        | { state: 'ok'; handle: string }
        | { state: 'error'; reason: string }
    >({ state: 'idle' });
    const handleCheckSeq = useRef(0);

    const suggestedHandle = useMemo(
        () => slugifyHandle(user?.name ?? ''),
        [user?.name],
    );

    useEffect(() => {
        setNameDraft(user?.name ?? '');
        setHandleDraft(user?.handle ?? '');
    }, [user?.name, user?.handle]);

    // Honour ``/account#section-id`` URL hashes by scrolling the matching
    // section into view once the page has rendered. React Router doesn't
    // do this automatically. Re-runs on hash change so an in-app link to
    // ``/account#network`` from a different page also lands correctly.
    useEffect(() => {
        if (!location.hash || loading) return;
        const id = location.hash.slice(1);
        // Defer to next paint so the target section is mounted.
        const t = window.setTimeout(() => {
            const el = document.getElementById(id);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
        return () => window.clearTimeout(t);
    }, [location.hash, loading, user]);

    // Debounced availability check on handle draft.
    useEffect(() => {
        if (!profileEditing) return;
        const candidate = handleDraft.trim().toLowerCase();
        if (!candidate || candidate === (user?.handle ?? '')) {
            setHandleStatus({ state: 'idle' });
            return;
        }
        if (!/^[a-z][a-z0-9_]{2,23}$/.test(candidate)) {
            setHandleStatus({
                state: 'error',
                reason: '3–24 chars, letters/numbers/underscore, must start with a letter',
            });
            return;
        }
        setHandleStatus({ state: 'checking' });
        const seq = ++handleCheckSeq.current;
        const t = setTimeout(() => {
            checkHandleAvailable(candidate)
                .then((res) => {
                    if (seq !== handleCheckSeq.current) return;
                    if (res.available) {
                        setHandleStatus({ state: 'ok', handle: res.handle });
                    } else {
                        setHandleStatus({
                            state: 'error',
                            reason: res.reason ?? 'Not available',
                        });
                    }
                })
                .catch(() => {
                    if (seq !== handleCheckSeq.current) return;
                    setHandleStatus({ state: 'error', reason: 'Check failed' });
                });
        }, 350);
        return () => clearTimeout(t);
    }, [handleDraft, profileEditing, user?.handle]);

    const handleProfileSave = async () => {
        setProfileSaving(true);
        setProfileError(null);
        try {
            const trimmedName = nameDraft.trim();
            const trimmedHandle = handleDraft.trim().toLowerCase();
            const payload: { display_name?: string; handle?: string } = {};
            if (trimmedName && trimmedName !== (user?.name ?? '')) {
                payload.display_name = trimmedName;
            }
            if (trimmedHandle && trimmedHandle !== (user?.handle ?? '')) {
                payload.handle = trimmedHandle;
            }
            if (Object.keys(payload).length === 0) {
                setProfileEditing(false);
                return;
            }
            await updateUserProfile(payload);
            await refreshUser();
            setProfileEditing(false);
        } catch (e) {
            setProfileError(e instanceof Error ? e.message : 'Failed to save');
        } finally {
            setProfileSaving(false);
        }
    };

    useEffect(() => {
        if (showRatings && user) {
            fetchMyRatings().then(setMyRatings).catch(() => setMyRatings([]));
        }
    }, [showRatings, user]);

    const allEventIds = useMemo(
        () => [...new Set([...savedEventIds, ...attendingEventIds])],
        [savedEventIds, attendingEventIds],
    );

    useEffect(() => {
        if (!user) {
            setMyEvents([]);
            return;
        }
        if (allEventIds.length === 0) {
            setMyEvents([]);
            return;
        }
        let cancelled = false;
        fetchEventsByIds(allEventIds)
            .then((evts) => {
                if (cancelled) return;
                const now = Date.now();
                setMyEvents(
                    evts
                        .filter((e) => new Date(e.end).getTime() >= now)
                        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
                );
            })
            .catch(() => { if (!cancelled) setMyEvents([]); });
        return () => { cancelled = true; };
    }, [user, allEventIds]);

    const handleEventClick = useCallback((evt: CalendarEvent) => {
        trackView(evt.event_id, 'account-my-events');
        setSelectedEvent(evt);
    }, []);

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <p className="text-slate-400">Loading…</p>
            </div>
        );
    }

    if (!user) {
        // Anonymous users still get the Settings page — the Preferences
        // section is the canonical editor for everyone (see plan.md §
        // Settings page). Profile / sign-out / activity sections are
        // replaced by a single sign-in CTA.
        return (
            <div className="mx-auto max-w-xl px-4 py-3 text-xs">
                <h1 className="text-lg font-bold text-slate-900 mb-3">Settings</h1>
                <PreferencesSection />
                <PushNotificationSettings />
                <InstallAppSection />
                <section className="rounded-lg border border-slate-200 bg-white p-4">
                    <h2 className="text-sm font-semibold text-slate-900 mb-2">Account</h2>
                    <p className="text-xs text-slate-600 mb-3">
                        Sign in with Google to sync your preferences across devices and
                        unlock saved events, “I’m going”, and your shareable calendar.
                    </p>
                    <Link
                        to="/login"
                        className="inline-block bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600"
                    >
                        Sign in
                    </Link>
                </section>
            </div>
        );
    }

    const handleSignOut = async () => {
        setBusy(true);
        try {
            await logout();
            navigate('/', { replace: true });
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async () => {
        setBusy(true);
        setError(null);
        try {
            await deleteAccount();
            navigate('/', { replace: true });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to delete account');
            setBusy(false);
        }
    };

    return (
        <div className="mx-auto max-w-xl px-4 py-3 text-xs">
            <h1 className="text-lg font-bold text-slate-900 mb-2">Settings</h1>

            <nav className="mb-3 flex gap-1.5 overflow-x-auto pb-1 scrollbar-none" aria-label="Settings sections">
                {[
                    { label: 'Profile', href: '#profile' },
                    { label: 'My events', href: '#my-events' },
                    { label: 'My network', href: '#network' },
                    { label: 'Preferences', href: '#preferences' },
                    { label: 'Privacy', href: '#privacy' },
                ].map((item) => (
                    <a
                        key={item.href}
                        href={item.href}
                        className="shrink-0 border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-blue-500 hover:text-blue-500"
                    >
                        {item.label}
                    </a>
                ))}
            </nav>

            <section id="profile" className="rounded-lg border border-slate-200 bg-white p-4 mb-3 scroll-mt-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                    <h2 className="text-sm font-semibold text-slate-900">Profile</h2>
                    {!profileEditing && (
                        <button
                            type="button"
                            onClick={() => {
                                setProfileEditing(true);
                                if (!handleDraft && suggestedHandle) {
                                    setHandleDraft(suggestedHandle);
                                }
                            }}
                            className="text-xs text-blue-500 hover:text-blue-600 font-medium"
                        >
                            Edit
                        </button>
                    )}
                </div>

                <div className="flex items-center gap-3">
                    {user.avatar_url ? (
                        <img
                            src={user.avatar_url}
                            alt=""
                            className="h-11 w-11 rounded-full"
                            referrerPolicy="no-referrer"
                        />
                    ) : (
                        <div className="h-11 w-11 rounded-full bg-slate-200 flex items-center justify-center text-base font-semibold text-slate-500">
                            {user.name?.[0]?.toUpperCase() ?? '?'}
                        </div>
                    )}
                    <div className="min-w-0">
                        <div className="flex min-w-0 items-baseline gap-1.5">
                            <span className="truncate text-sm font-semibold text-slate-900">{user.name}</span>
                            {user.handle ? (
                                <span className="shrink-0 font-mono text-xs text-slate-500">@{user.handle}</span>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setProfileEditing(true);
                                        if (suggestedHandle) setHandleDraft(suggestedHandle);
                                    }}
                                    className="shrink-0 text-xs text-blue-500 hover:text-blue-600"
                                >
                                    set handle
                                </button>
                            )}
                        </div>
                        <div className="truncate text-xs text-slate-500">{user.email}</div>
                        {user.is_admin && (
                            <div className="text-xs text-amber-700 mt-1">Administrator</div>
                        )}
                    </div>
                </div>

                {profileEditing && (
                    <div className="mt-3 space-y-3">
                        <label className="block">
                            <span className="block text-xs font-medium text-slate-600 mb-1">
                                Display name
                            </span>
                            <input
                                type="text"
                                value={nameDraft}
                                onChange={(e) => setNameDraft(e.target.value)}
                                maxLength={120}
                                className="w-full border border-slate-300 px-3 py-2 text-xs"
                            />
                        </label>
                        <label className="block">
                            <span className="block text-xs font-medium text-slate-600 mb-1">
                                Handle
                            </span>
                            <div className="flex items-stretch border border-slate-300 overflow-hidden focus-within:border-slate-400">
                                <span className="bg-slate-50 px-2 py-2 text-xs text-slate-500 border-r border-slate-300">
                                    @
                                </span>
                                <input
                                    type="text"
                                    value={handleDraft}
                                    onChange={(e) => setHandleDraft(e.target.value)}
                                    maxLength={24}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    placeholder={suggestedHandle || 'your_handle'}
                                    className="flex-1 px-3 py-2 text-xs font-mono outline-none"
                                />
                            </div>
                            <span className="block mt-1 text-xs min-h-[1rem]">
                                {handleStatus.state === 'checking' && (
                                    <span className="text-slate-500">Checking…</span>
                                )}
                                {handleStatus.state === 'ok' && (
                                    <span className="text-emerald-700">
                                        @{handleStatus.handle} is available
                                    </span>
                                )}
                                {handleStatus.state === 'error' && (
                                    <span className="text-red-700">{handleStatus.reason}</span>
                                )}
                                {handleStatus.state === 'idle' && (
                                    <span className="text-slate-400">
                                        Used for your public profile URL.
                                    </span>
                                )}
                            </span>
                        </label>
                        {profileError && (
                            <p className="text-xs text-red-700">{profileError}</p>
                        )}
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleProfileSave}
                                disabled={profileSaving || handleStatus.state === 'checking' || handleStatus.state === 'error'}
                                className="bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
                            >
                                {profileSaving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setProfileEditing(false);
                                    setProfileError(null);
                                    setNameDraft(user.name ?? '');
                                    setHandleDraft(user.handle ?? '');
                                }}
                                disabled={profileSaving}
                                className="border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                <BioEditor handle={user.handle ?? null} />
                <ProfileLinksEditor handle={user.handle ?? null} />
            </section>

            {organizerClaimsEnabled && (
                <div className="mb-3">
                    <OrganizerClaimSection handle={user.handle ?? null} />
                </div>
            )}

            <div id="my-events" className="mb-3 scroll-mt-4">
                {myEvents.length > 0 ? (
                    <YourNextEventsRail
                        events={myEvents}
                        onEventClick={handleEventClick}
                        headerRight={(
                            <>
                                <span>{savedCount} saved</span>
                                <span className="text-slate-300">·</span>
                                <span>{attendingCount} going</span>
                            </>
                        )}
                    />
                ) : (
                    <section className="border border-slate-200 bg-white shadow-sm" data-testid="your-next-events-rail-empty">
                        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-3 py-1.5">
                            <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">Your next events</span>
                            <div className="ml-auto flex items-center gap-2 text-xs text-slate-600">
                                <span>{savedCount} saved</span>
                                <span className="text-slate-300">·</span>
                                <span>{attendingCount} going</span>
                            </div>
                        </div>
                        <div className="px-3 py-4 text-center">
                            <p className="text-xs text-slate-500">
                                No events yet. Save events or mark “I’m going” to see them here.
                            </p>
                            <Link
                                to="/"
                                className="mt-2 inline-block text-xs font-medium text-blue-500 hover:text-blue-600"
                            >
                                Browse events →
                            </Link>
                        </div>
                    </section>
                )}
            </div>

            <NetworkPanel />

            <ReferralCard />

            <div id="preferences" className="scroll-mt-4">
                <PreferencesSection />
            </div>

            <div id="notifications" className="scroll-mt-4">
                <NotificationSettings />
                <PushNotificationSettings />
                <InstallAppSection />
            </div>

            <div id="privacy" className="scroll-mt-4">
                <VisibilitySection handle={user.handle ?? null} />
            </div>


            {showRatings && (
                <section className="rounded-lg border border-slate-200 bg-white p-4 mb-3">
                    <h2 className="text-sm font-semibold text-slate-900 mb-3">My Ratings</h2>
                    {myRatings === null ? (
                        <p className="text-xs text-slate-400">Loading…</p>
                    ) : myRatings.length === 0 ? (
                        <p className="text-xs text-slate-500">You haven't rated any events yet.</p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {myRatings.map((r) => (
                                <li key={r.id} className="py-2.5">
                                    <Link
                                        to={`/event/${r.event_id}`}
                                        className="text-xs font-medium text-slate-800 hover:text-blue-500"
                                    >
                                        {r.event_title || r.event_id}
                                    </Link>
                                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                                        <span className="text-amber-500">
                                            {'★'.repeat(r.stars)}{'☆'.repeat(5 - r.stars)}
                                        </span>
                                        <span className="capitalize">{r.status}</span>
                                        {r.is_anonymous && <span>· anonymous</span>}
                                        <span className="ml-auto">
                                            {new Date(r.created_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                    {r.comment && (
                                        <p className="text-xs text-slate-600 mt-1 line-clamp-2">{r.comment}</p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}

            <section className="rounded-lg border border-slate-200 bg-white p-4 mb-3">
                <h2 className="text-sm font-semibold text-slate-900 mb-2">Help &amp; feedback</h2>
                <p className="text-xs text-slate-600 mb-2">
                    Found a bug, have an idea, or want to say hi? We read every message.
                </p>
                <a
                    href="mailto:support@joinmovida.com?subject=Movida%20feedback"
                    className="inline-block border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                    Send feedback
                </a>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-4 mb-3">
                <h2 className="text-sm font-semibold text-slate-900 mb-3">Session</h2>
                <button
                    onClick={handleSignOut}
                    disabled={busy}
                    className="border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                    Sign out
                </button>
            </section>

            <section className="rounded-lg border border-red-200 bg-red-50 p-4">
                <h2 className="text-sm font-semibold text-red-900 mb-2">Delete your account</h2>
                <p className="text-xs text-red-800 mb-3">
                    Permanently removes your account and all personal data we hold for you
                    (saved events, attending events, share link). This cannot be undone.
                    See our{' '}
                    <Link to="/privacy" className="underline">privacy policy</Link>.
                </p>
                {error && <p className="text-xs text-red-700 mb-3">{error}</p>}
                {!confirming ? (
                    <button
                        onClick={() => setConfirming(true)}
                        disabled={busy}
                        className="bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                        Delete my account
                    </button>
                ) : (
                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleDelete}
                            disabled={busy}
                            className="bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                            {busy ? 'Deleting…' : 'Yes, permanently delete'}
                        </button>
                        <button
                            onClick={() => setConfirming(false)}
                            disabled={busy}
                            className="border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </section>

            {selectedEvent && (
                <EventModal
                    event={selectedEvent}
                    onClose={() => setSelectedEvent(null)}
                />
            )}
        </div>
    );
}
