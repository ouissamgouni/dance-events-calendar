import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import {
    checkHandleAvailable,
    fetchMyRatings,
    updateUserPreferences,
    updateUserProfile,
} from '../api';
import type { MyRating } from '../types';

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
    const { savedCount } = useSavedEvents();
    const { attendingCount } = useAttendingEvents();
    const { showRatings } = useFeatureFlags();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [myRatings, setMyRatings] = useState<MyRating[] | null>(null);
    const [shareDefault, setShareDefault] = useState<boolean>(user?.share_attendance_default ?? true);
    const [shareSaving, setShareSaving] = useState(false);

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
        setShareDefault(user?.share_attendance_default ?? true);
    }, [user?.share_attendance_default]);

    useEffect(() => {
        if (showRatings && user) {
            fetchMyRatings().then(setMyRatings).catch(() => setMyRatings([]));
        }
    }, [showRatings, user]);

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <p className="text-slate-400">Loading…</p>
            </div>
        );
    }

    if (!user) {
        return <Navigate to="/login" replace />;
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
        <div className="mx-auto max-w-xl px-6 py-10">
            <h1 className="text-2xl font-bold text-slate-900 mb-6">Your account</h1>

            <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                <div className="flex items-center gap-4">
                    {user.avatar_url ? (
                        <img
                            src={user.avatar_url}
                            alt=""
                            className="h-14 w-14 rounded-full"
                            referrerPolicy="no-referrer"
                        />
                    ) : (
                        <div className="h-14 w-14 rounded-full bg-slate-200 flex items-center justify-center text-xl font-semibold text-slate-500">
                            {user.name?.[0]?.toUpperCase() ?? '?'}
                        </div>
                    )}
                    <div>
                        <div className="font-semibold text-slate-900">{user.name}</div>
                        <div className="text-sm text-slate-500">{user.email}</div>
                        {user.is_admin && (
                            <div className="text-xs text-amber-700 mt-1">Administrator</div>
                        )}
                    </div>
                </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                <div className="flex items-start justify-between gap-4">
                    <h2 className="text-base font-semibold text-slate-900">Profile</h2>
                    {!profileEditing && (
                        <button
                            type="button"
                            onClick={() => {
                                setProfileEditing(true);
                                if (!handleDraft && suggestedHandle) {
                                    setHandleDraft(suggestedHandle);
                                }
                            }}
                            className="text-sm text-rose-600 hover:text-rose-700 font-medium"
                        >
                            Edit
                        </button>
                    )}
                </div>

                {!profileEditing ? (
                    <dl className="mt-3 space-y-2 text-sm">
                        <div className="flex gap-2">
                            <dt className="w-24 text-slate-500">Name</dt>
                            <dd className="text-slate-900">{user.name}</dd>
                        </div>
                        <div className="flex gap-2 items-baseline">
                            <dt className="w-24 text-slate-500">Handle</dt>
                            <dd className="text-slate-900">
                                {user.handle ? (
                                    <span className="font-mono">@{user.handle}</span>
                                ) : (
                                    <span className="text-amber-700">
                                        Not set —{' '}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setProfileEditing(true);
                                                if (suggestedHandle) setHandleDraft(suggestedHandle);
                                            }}
                                            className="underline"
                                        >
                                            pick one
                                        </button>
                                    </span>
                                )}
                            </dd>
                        </div>
                    </dl>
                ) : (
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
                                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                            />
                        </label>
                        <label className="block">
                            <span className="block text-xs font-medium text-slate-600 mb-1">
                                Handle
                            </span>
                            <div className="flex items-stretch rounded-md border border-slate-300 overflow-hidden focus-within:border-slate-400">
                                <span className="bg-slate-50 px-2 py-2 text-sm text-slate-500 border-r border-slate-300">
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
                                    className="flex-1 px-3 py-2 text-sm font-mono outline-none"
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
                            <p className="text-sm text-red-700">{profileError}</p>
                        )}
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleProfileSave}
                                disabled={profileSaving || handleStatus.state === 'checking' || handleStatus.state === 'error'}
                                className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
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
                                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                <h2 className="text-base font-semibold text-slate-900 mb-2">My Events</h2>
                <p className="text-sm text-slate-600">
                    {savedCount} saved · {attendingCount} going
                </p>
                <Link to="/my-calendar" className="mt-2 inline-block text-sm text-rose-600 hover:text-rose-700 font-medium">
                    Show calendar →
                </Link>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                <h2 className="text-base font-semibold text-slate-900 mb-2">Sync</h2>
                <p className="text-sm text-slate-600">
                    Your bookmarked events, “I’m going” events, and your share-my-calendar
                    link are synced to this account and follow you across devices.
                </p>
            </section>

            {showRatings && (
                <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                    <h2 className="text-base font-semibold text-slate-900 mb-3">My Ratings</h2>
                    {myRatings === null ? (
                        <p className="text-sm text-slate-400">Loading…</p>
                    ) : myRatings.length === 0 ? (
                        <p className="text-sm text-slate-500">You haven't rated any events yet.</p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {myRatings.map((r) => (
                                <li key={r.id} className="py-2.5">
                                    <Link
                                        to={`/event/${r.event_id}`}
                                        className="text-sm font-medium text-slate-800 hover:text-rose-600"
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

            <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                <h2 className="text-base font-semibold text-slate-900 mb-2">Privacy</h2>
                <label className="flex items-start gap-3 text-sm text-slate-700 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={shareDefault}
                        disabled={shareSaving}
                        onChange={async (e) => {
                            const next = e.target.checked;
                            setShareDefault(next);
                            setShareSaving(true);
                            try {
                                await updateUserPreferences({ share_attendance_default: next });
                                // Refresh AuthContext so other consumers
                                // (e.g. GoingButton on the same page) see
                                // the new value without a full reload.
                                await refreshUser();
                            } catch {
                                setShareDefault(!next);
                            } finally {
                                setShareSaving(false);
                            }
                        }}
                        className="mt-0.5"
                    />
                    <span>
                        Share my name by default when I mark myself going to an event.
                        <span className="block text-xs text-slate-500 mt-0.5">
                            When enabled, you will appear in the attendee list shown to other
                            signed-in users. You can override this per-event from the “I’m going”
                            button.
                        </span>
                    </span>
                </label>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                <h2 className="text-base font-semibold text-slate-900 mb-2">Help &amp; feedback</h2>
                <p className="text-sm text-slate-600 mb-2">
                    Found a bug, have an idea, or want to say hi? We read every message.
                </p>
                <a
                    href="mailto:support@joinmovida.com?subject=Movida%20feedback"
                    className="inline-block rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                    Send feedback
                </a>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
                <h2 className="text-base font-semibold text-slate-900 mb-3">Session</h2>
                <button
                    onClick={handleSignOut}
                    disabled={busy}
                    className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                    Sign out
                </button>
            </section>

            <section className="rounded-lg border border-red-200 bg-red-50 p-6">
                <h2 className="text-base font-semibold text-red-900 mb-2">Delete your account</h2>
                <p className="text-sm text-red-800 mb-3">
                    Permanently removes your account and all personal data we hold for you
                    (saved events, attending events, share link). This cannot be undone.
                    See our{' '}
                    <Link to="/privacy" className="underline">privacy policy</Link>.
                </p>
                {error && <p className="text-sm text-red-700 mb-3">{error}</p>}
                {!confirming ? (
                    <button
                        onClick={() => setConfirming(true)}
                        disabled={busy}
                        className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                        Delete my account
                    </button>
                ) : (
                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleDelete}
                            disabled={busy}
                            className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                            {busy ? 'Deleting…' : 'Yes, permanently delete'}
                        </button>
                        <button
                            onClick={() => setConfirming(false)}
                            disabled={busy}
                            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </section>
        </div>
    );
}
