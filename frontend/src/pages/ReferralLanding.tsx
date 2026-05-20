/**
 * Phase E (E7) — referral landing page.
 *
 * Public URL ``/r/:code`` invoked when someone opens an inviter's
 * share link. The page:
 *   1. Stores the code in a 30-day cookie ``ref_code`` so it survives
 *      the Google OAuth round-trip;
 *   2. If the visitor is ALREADY signed in, immediately attempts
 *      ``POST /api/auth/redeem-referral`` (consent inferred from the
 *      explicit click on the inviter link — Art. 7 GDPR specific
 *      action) and surfaces the outcome;
 *   3. Otherwise redirects to ``/login`` and lets the post-login flow
 *      (see ``AuthContext``) consume the cookie.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { redeemReferral } from '../api';
import { useAuth } from '../context/AuthContext';

const COOKIE_NAME = 'ref_code';
const COOKIE_TTL_DAYS = 30;

function setRefCookie(code: string): void {
    const maxAge = COOKIE_TTL_DAYS * 24 * 60 * 60;
    document.cookie =
        `${COOKIE_NAME}=${encodeURIComponent(code)}; ` +
        `Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

export default function ReferralLanding() {
    const { code } = useParams<{ code: string }>();
    const { user, loading } = useAuth();
    const navigate = useNavigate();
    const [status, setStatus] = useState<
        | { kind: 'idle' }
        | { kind: 'redeemed'; inviter: string | null; mutual: boolean }
        | { kind: 'error'; message: string }
    >({ kind: 'idle' });

    useEffect(() => {
        if (!code) return;
        setRefCookie(code);
    }, [code]);

    useEffect(() => {
        if (loading || !code) return;
        if (!user) {
            const t = window.setTimeout(
                () => navigate('/login', { replace: true }),
                800,
            );
            return () => window.clearTimeout(t);
        }
        let cancelled = false;
        redeemReferral(code, true)
            .then((r) => {
                if (cancelled) return;
                setStatus({
                    kind: 'redeemed',
                    inviter: r.inviter_handle,
                    mutual: r.mutual_follow_created,
                });
                window.dispatchEvent(new CustomEvent('network:changed'));
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setStatus({
                    kind: 'error',
                    message: e instanceof Error ? e.message : String(e),
                });
            });
        return () => { cancelled = true; };
    }, [code, user, loading, navigate]);

    return (
        <div className="mx-auto max-w-md px-4 py-12 text-center">
            <h1 className="text-xl font-semibold text-slate-900 mb-3">
                Welcome to Movida
            </h1>
            {!user && !loading && (
                <p className="text-sm text-slate-600">
                    Sign in to accept your invite…
                </p>
            )}
            {user && status.kind === 'idle' && (
                <p className="text-sm text-slate-600">Linking you up…</p>
            )}
            {status.kind === 'redeemed' && status.inviter && (
                <>
                    <p className="text-sm text-slate-700">
                        You and <strong>@{status.inviter}</strong> are now {status.mutual ? 'mutual friends' : 'connected'}.
                    </p>
                    <Link
                        to="/"
                        className="mt-4 inline-block bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
                    >
                        Explore events
                    </Link>
                </>
            )}
            {status.kind === 'redeemed' && !status.inviter && (
                <>
                    <p className="text-sm text-slate-600">
                        That invite link isn't valid anymore.
                    </p>
                    <Link
                        to="/"
                        className="mt-4 inline-block bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
                    >
                        Continue
                    </Link>
                </>
            )}
            {status.kind === 'error' && (
                <div className="border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    {status.message}
                </div>
            )}
        </div>
    );
}
