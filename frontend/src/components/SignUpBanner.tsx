import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getActiveReferral } from '../hooks/useReferralAttribution';

const STORAGE_KEY = 'signup_banner_dismissed_at';
// Re-show the banner this many days after a dismiss so users who weren't
// ready the first time get a second nudge later.
const RESHOW_AFTER_DAYS = 14;

function isDismissedRecently(): boolean {
    try {
        const ts = localStorage.getItem(STORAGE_KEY);
        if (!ts) return false;
        const dismissedAt = Number(ts);
        if (!Number.isFinite(dismissedAt)) return false;
        const ageMs = Date.now() - dismissedAt;
        return ageMs < RESHOW_AFTER_DAYS * 24 * 60 * 60 * 1000;
    } catch {
        return false;
    }
}

/** Detect an active ``?ref=share&src=…`` attribution \u2014 either persisted
 *  in localStorage or still present in the current URL (e.g. on first
 *  paint of a deep link, before the route child has run its effect). */
function hasActiveShareReferral(): boolean {
    if (getActiveReferral()) return true;
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('ref') === 'share' && !!params.get('src');
}

/**
 * Slim, anonymous-only sign-in nudge rendered under the top nav.
 * Dismiss is sticky for ``RESHOW_AFTER_DAYS`` days via localStorage.
 * Hidden immediately on sign-in, and also suppressed when the
 * share-referral banner is active so anon visitors aren't faced with
 * two stacked sign-in CTAs (the share-referral banner carries its own
 * value-prop copy in that case).
 * Pairs with the per-action `SignInNudge` popover; this banner sets
 * the value prop, that popover converts intent.
 */
export default function SignUpBanner() {
    const { user, loading } = useAuth();
    const { pathname } = useLocation();
    const [dismissed, setDismissed] = useState<boolean>(true);
    const [shareReferralActive, setShareReferralActive] = useState<boolean>(false);

    useEffect(() => {
        // Defer the localStorage check to mount so SSR/first-render is
        // deterministic and we don't flash the banner on signed-in reloads.
        setDismissed(isDismissedRecently());
        const evaluate = () => setShareReferralActive(hasActiveShareReferral());
        evaluate();
        // Re-evaluate when the route child persists the attribution.
        window.addEventListener('referral:changed', evaluate);
        return () => window.removeEventListener('referral:changed', evaluate);
    }, []);

    if (loading || user || dismissed || shareReferralActive || pathname === '/login') return null;

    const handleDismiss = () => {
        try {
            localStorage.setItem(STORAGE_KEY, String(Date.now()));
        } catch { /* ignore quota / privacy-mode errors */ }
        setDismissed(true);
    };

    return (
        <div
            role="region"
            aria-label="Sign in promotion"
            className="flex items-center justify-between gap-3 bg-blue-50 border-b border-blue-100 px-4 py-1.5 text-xs text-slate-700"
        >
            <p className="min-w-0 sm:truncate truncate sm:whitespace-normal">
                <span className="hidden sm:inline">
                    Sign in to save events across your devices, see who else is going, share your calendar, rate events, get notifications and more.
                </span>
                <span className="sm:hidden">
                    Sign in to save, see who's going, rate, share and more.
                </span>
            </p>
            <div className="flex items-center gap-2 shrink-0">
                <Link
                    to="/login"
                    className="bg-blue-500 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-600 transition"
                >
                    Sign in
                </Link>
                <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label="Dismiss sign-in banner"
                    className="text-slate-400 hover:text-slate-600 text-base leading-none px-1"
                >
                    ×
                </button>
            </div>
        </div>
    );
}
