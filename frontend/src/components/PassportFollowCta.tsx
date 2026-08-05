/**
 * Follow call-to-action shown alongside a shared/profile Dance Passport.
 *
 * - Owner viewing their own passport → nothing.
 * - Already following → a subtle "Following" badge.
 * - Signed-in viewer, not following → a Follow button (POST /follow).
 * - Anonymous viewer → a sign-in prompt linking to /login.
 *
 * Rendered via PassportView's `headerActions` slot on both the public share
 * page and the profile "Dance Passport" tab.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { followUser } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from './Toast';

/** localStorage key holding the handle an anonymous viewer intended to follow. */
const FOLLOW_INTENT_KEY = 'passport_follow_intent';

export default function PassportFollowCta({
    handle,
    isSelf,
    isFollowing,
    displayName,
}: {
    handle: string | null;
    isSelf: boolean;
    isFollowing: boolean;
    displayName?: string | null;
}) {
    const { user } = useAuth();
    const toast = useToast();
    const [following, setFollowing] = useState(isFollowing);
    const [pending, setPending] = useState<'approved' | 'pending' | null>(null);
    const [busy, setBusy] = useState(false);

    // Replay a pending follow captured before the viewer signed in (they
    // clicked "Sign in to follow" while anonymous, then authenticated and were
    // returned here). Fires once, then clears the stored intent.
    useEffect(() => {
        if (!user || !handle || isSelf || following) return;
        let intent: string | null = null;
        try {
            intent = localStorage.getItem(FOLLOW_INTENT_KEY);
        } catch {
            intent = null;
        }
        if (intent !== handle) return;
        try {
            localStorage.removeItem(FOLLOW_INTENT_KEY);
        } catch {
            // ignore storage errors
        }
        followUser(handle)
            .then((res) => {
                if (res.follow_status === 'pending') setPending('pending');
                else setFollowing(res.is_following);
                const label = displayName?.trim() || `@${handle}`;
                toast.push({
                    title: res.follow_status === 'pending' ? 'Request sent' : 'Following',
                    message:
                        res.follow_status === 'pending'
                            ? `Your request to follow ${label} was sent.`
                            : `You're now following ${label}.`,
                    variant: 'success',
                });
            })
            .catch(() => {
                // Non-fatal: the viewer can still tap Follow manually.
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- run when auth/handle resolves
    }, [user, handle, isSelf]);

    // Nothing to offer without a handle, for the owner, or when already following.
    if (!handle || isSelf) return null;

    const who = displayName?.trim() || `@${handle}`;

    // Anonymous viewers get a sign-in prompt instead of a live Follow button.
    // We stash the intended follow and ask auth to return here so the follow
    // completes automatically once they're signed in.
    if (!user) {
        const nextPath = `${window.location.pathname}${window.location.search}`;
        return (
            <Link
                to={`/login?next=${encodeURIComponent(nextPath)}`}
                onClick={() => {
                    try {
                        localStorage.setItem(FOLLOW_INTENT_KEY, handle);
                    } catch {
                        // ignore storage errors
                    }
                }}
                className="inline-flex items-center gap-1.5 border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
                Sign in to follow {who}
            </Link>
        );
    }

    if (following || pending === 'approved') {
        return (
            <span className="inline-flex items-center gap-1.5 border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-600">
                Following
            </span>
        );
    }

    if (pending === 'pending') {
        return (
            <span className="inline-flex items-center gap-1.5 border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-600">
                Request sent
            </span>
        );
    }

    const handleFollow = async () => {
        setBusy(true);
        try {
            const res = await followUser(handle);
            if (res.follow_status === 'pending') {
                setPending('pending');
            } else {
                setFollowing(res.is_following);
            }
        } catch {
            toast.push({
                title: 'Could not follow',
                message: 'Please try again.',
                variant: 'error',
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <button
            type="button"
            onClick={handleFollow}
            disabled={busy}
            className="inline-flex items-center gap-1.5 border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
            {busy ? 'Following…' : `Follow ${who}`}
        </button>
    );
}
