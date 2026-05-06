import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { fetchMyRatings, updateUserPreferences } from '../api';
import type { MyRating } from '../types';

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
    const [shareDefault, setShareDefault] = useState<boolean>(user?.share_attendance_default ?? false);
    const [shareSaving, setShareSaving] = useState(false);

    useEffect(() => {
        setShareDefault(user?.share_attendance_default ?? false);
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
