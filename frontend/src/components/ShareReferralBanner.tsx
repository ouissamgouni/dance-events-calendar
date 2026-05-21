import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
    fetchShareSource,
    redeemShareFollow,
    type ShareSourceResponse,
} from '../api';
import { getActiveReferral } from '../hooks/useReferralAttribution';

// Per-share dismiss key so users who tick off one sharer aren't pestered,
// but a NEW share-link still surfaces the banner once.
const DISMISS_KEY_PREFIX = 'share_referral_banner_dismissed:';
// Per-share consumed flag so we never redeem twice for the same
// ``share_code`` even across hard refreshes.
const CONSUMED_KEY_PREFIX = 'share_referral_banner_consumed:';
// Per-share intent flag set when an anon visitor clicks "Sign in" while
// the "Follow them" opt-in is checked. After they complete sign-in we
// auto-fire the redemption and skip the extra "Continue" click.
const INTENT_KEY_PREFIX = 'share_referral_banner_intent:';

function isDismissed(shareCode: string): boolean {
    try {
        return !!localStorage.getItem(DISMISS_KEY_PREFIX + shareCode);
    } catch {
        return false;
    }
}

function markDismissed(shareCode: string): void {
    try {
        localStorage.setItem(DISMISS_KEY_PREFIX + shareCode, String(Date.now()));
    } catch { /* ignore quota / privacy-mode errors */ }
}

function isConsumed(shareCode: string): boolean {
    try {
        return !!localStorage.getItem(CONSUMED_KEY_PREFIX + shareCode);
    } catch {
        return false;
    }
}

function markConsumed(shareCode: string): void {
    try {
        localStorage.setItem(CONSUMED_KEY_PREFIX + shareCode, String(Date.now()));
    } catch { /* ignore */ }
}

function setIntent(shareCode: string): void {
    try {
        localStorage.setItem(INTENT_KEY_PREFIX + shareCode, String(Date.now()));
    } catch { /* ignore */ }
}

function hasIntent(shareCode: string): boolean {
    try {
        return !!localStorage.getItem(INTENT_KEY_PREFIX + shareCode);
    } catch {
        return false;
    }
}

function clearIntent(shareCode: string): void {
    try {
        localStorage.removeItem(INTENT_KEY_PREFIX + shareCode);
    } catch { /* ignore */ }
}

/**
 * Phase 3 (D2) — share-link doubles as referral.
 *
 * Rendered globally under the top nav. When the visitor has an active
 * ``?ref=share&src=<share_code>`` attribution in localStorage (captured
 * by ``useReferralAttribution``) AND that share_code resolves to a
 * known user, surface a slim "Follow @sharer?" prompt with the
 * opt-out checkbox DEFAULTED ON (D2 decision matrix).
 *
 * - For ANON visitors: shows the prompt + a value-prop subtext + a
 *   "Sign in" CTA. When the opt-in stays checked at click time we
 *   stash an intent flag in localStorage and auto-fire the redemption
 *   after sign-in (skipping a redundant "Continue" click).
 * - For SIGNED-IN visitors: shows the prompt with an inline "Continue"
 *   button. Unticking the checkbox dismisses the banner without any
 *   network call.
 *
 * Self-shares (the sharer arriving on their own link) are filtered
 * out client-side; the backend also no-ops, but skipping the request
 * avoids a needless 200.
 *
 * Follow semantics: ONE-WAY (viewer→sharer only). The sharer is not
 * auto-followed back — sharing a link isn't strong enough consent to
 * befriend a stranger. The sharer gets a regular new-follower
 * notification and can follow back manually.
 *
 * Note: share-link conversions do NOT bump
 * ``user_referrals.used_count`` — that surface stays invite-only
 * (D2 decision).
 */
export default function ShareReferralBanner() {
    const { user, loading: authLoading } = useAuth();
    const [shareCode, setShareCode] = useState<string | null>(null);
    const [source, setSource] = useState<ShareSourceResponse | null>(null);
    const [followOptIn, setFollowOptIn] = useState(true);
    const [status, setStatus] = useState<
        | { kind: 'idle' }
        | { kind: 'redeeming' }
        | { kind: 'redeemed'; handle: string | null }
        | { kind: 'error'; message: string }
    >({ kind: 'idle' });

    // Read the active attribution. Re-runs when auth changes so a fresh
    // sign-in re-evaluates the banner state. Also listens for
    // ``referral:changed`` because this banner is mounted at the App level
    // and its effect fires BEFORE the route child (EventDetailPage) gets a
    // chance to persist ``?ref=share&src=…`` into localStorage.
    useEffect(() => {
        const evaluate = () => {
            // Prefer the persisted attribution, but fall back to a direct
            // URL read so the banner shows on first paint of an
            // ``?ref=share&src=…`` deep link without waiting for the
            // child route's effect to run.
            let src: string | null = null;
            const ref = getActiveReferral();
            if (ref) {
                src = ref.src;
            } else if (typeof window !== 'undefined') {
                const params = new URLSearchParams(window.location.search);
                if (params.get('ref') === 'share') {
                    src = params.get('src');
                }
            }
            if (!src || isConsumed(src) || isDismissed(src)) {
                setShareCode(null);
                return;
            }
            setShareCode(src);
        };
        evaluate();
        window.addEventListener('referral:changed', evaluate);
        return () => window.removeEventListener('referral:changed', evaluate);
    }, [user?.user_id]);

    // Resolve the sharer preview.
    useEffect(() => {
        if (!shareCode) {
            setSource(null);
            return;
        }
        let cancelled = false;
        fetchShareSource(shareCode)
            .then((r) => {
                if (cancelled) return;
                setSource(r);
            })
            .catch(() => {
                if (cancelled) return;
                setSource(null);
            });
        return () => { cancelled = true; };
    }, [shareCode]);

    // Auto-hide after a successful redemption. Declared unconditionally
    // (React Rules of Hooks) and short-circuits when status is not
    // ``redeemed``.
    useEffect(() => {
        if (status.kind !== 'redeemed') return;
        const t = window.setTimeout(() => setShareCode(null), 6000);
        return () => window.clearTimeout(t);
    }, [status.kind]);

    // Auto-redeem after sign-in when the anon visitor had ticked the
    // "Follow them" opt-in and clicked "Sign in" (Q3 option B). The
    // intent flag is per-share so we don't redeem an unrelated old
    // attribution. Guard on ``status.kind === 'idle'`` so we don't
    // re-fire on every render and so an in-flight or completed
    // redemption short-circuits.
    useEffect(() => {
        if (!user || !shareCode || !source || status.kind !== 'idle') return;
        if (!hasIntent(shareCode)) return;
        if (user.share_code === shareCode) {
            // Self-share — don't redeem; clear intent so a future sign-in
            // doesn't pick up a stale flag.
            clearIntent(shareCode);
            return;
        }
        clearIntent(shareCode);
        setStatus({ kind: 'redeeming' });
        redeemShareFollow(shareCode, true)
            .then((r) => {
                markConsumed(shareCode);
                setStatus({ kind: 'redeemed', handle: r.sharer_handle });
                window.dispatchEvent(new CustomEvent('network:changed'));
            })
            .catch((e: unknown) => {
                setStatus({
                    kind: 'error',
                    message: e instanceof Error ? e.message : String(e),
                });
            });
    }, [user, shareCode, source, status.kind]);

    // ``handle`` is optional on a User (auto-assigned for share_code only,
    // not for handle). Fall back to display_name so the banner still
    // renders for users who never picked a handle.
    const sharerLabel = source?.handle ?? source?.display_name ?? null;
    if (authLoading || !shareCode || !source || !sharerLabel) return null;

    // Filter self-shares — the signed-in user is the same person who
    // generated this share_code. Banner has nothing useful to say.
    if (user && user.share_code === shareCode) return null;

    // Only prefix with ``@`` when we have a real handle; display_name is
    // free-form ("Sharer Persona") and shouldn't be ``@``-prefixed.
    const sharerLabelDisplay = source.handle ? `@${source.handle}` : sharerLabel;

    const handleDismiss = () => {
        markDismissed(shareCode);
        setShareCode(null);
    };

    const handleConfirm = () => {
        if (!user) return;
        if (!followOptIn) {
            // User unticked — treat as a soft dismiss for this share_code.
            handleDismiss();
            return;
        }
        setStatus({ kind: 'redeeming' });
        redeemShareFollow(shareCode, true)
            .then((r) => {
                markConsumed(shareCode);
                setStatus({ kind: 'redeemed', handle: r.sharer_handle });
                window.dispatchEvent(new CustomEvent('network:changed'));
            })
            .catch((e: unknown) => {
                setStatus({
                    kind: 'error',
                    message: e instanceof Error ? e.message : String(e),
                });
            });
    };

    if (status.kind === 'redeemed') {
        return (
            <div
                role="status"
                data-testid="share-referral-banner-redeemed"
                className="flex items-center justify-between gap-3 bg-emerald-50 border-b border-emerald-100 px-4 py-1.5 text-xs text-slate-700"
            >
                <p>
                    You're now following{' '}
                    <strong>{status.handle ? `@${status.handle}` : sharerLabelDisplay}</strong>.
                </p>
                {(status.handle ?? source.handle) ? (
                    <Link
                        to={`/u/${status.handle ?? source.handle}`}
                        className="bg-blue-500 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-600 transition"
                    >
                        Open profile
                    </Link>
                ) : null}
            </div>
        );
    }

    return (
        <div
            role="region"
            aria-label="Share-link follow prompt"
            data-testid="share-referral-banner"
            className="flex items-center justify-between gap-3 bg-blue-50 border-b border-blue-100 px-4 py-1.5 text-xs text-slate-700"
        >
            <div className="flex items-center gap-2 min-w-0">
                {source.avatar_url ? (
                    <img
                        src={source.avatar_url}
                        alt=""
                        className="h-5 w-5 rounded-full object-cover shrink-0"
                    />
                ) : null}
                <p className="min-w-0 truncate sm:whitespace-normal">
                    You arrived via <strong>{sharerLabelDisplay}</strong>{' '}
                    {user ? '— follow them?' : '— sign in to follow them.'}
                    {!user ? (
                        <span className="hidden sm:inline text-slate-500">
                            {' '}Signing in also lets you save events across devices,
                            see who else is going, share your calendar, rate events
                            and get notifications.
                        </span>
                    ) : null}
                </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-600 select-none">
                    <input
                        type="checkbox"
                        data-testid="share-referral-opt-in"
                        checked={followOptIn}
                        onChange={(e) => setFollowOptIn(e.target.checked)}
                        className="h-3 w-3 accent-blue-500"
                    />
                    Follow them
                </label>
                {user ? (
                    <button
                        type="button"
                        onClick={handleConfirm}
                        disabled={status.kind === 'redeeming'}
                        className="bg-blue-500 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-600 transition disabled:opacity-60"
                    >
                        {status.kind === 'redeeming' ? 'Following…' : 'Continue'}
                    </button>
                ) : (
                    <Link
                        to="/login"
                        onClick={() => {
                            // Stash intent so we auto-redeem post-login
                            // instead of forcing a second "Continue" click.
                            // Cleared in either branch of the auto-redeem
                            // effect above.
                            if (followOptIn) setIntent(shareCode);
                        }}
                        className="bg-blue-500 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-600 transition"
                    >
                        Sign in
                    </Link>
                )}
                <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label="Dismiss share-referral banner"
                    className="text-slate-400 hover:text-slate-600 text-base leading-none px-1"
                >
                    ×
                </button>
            </div>
            {status.kind === 'error' ? (
                <p className="text-rose-600 text-[11px]">{status.message}</p>
            ) : null}
        </div>
    );
}
