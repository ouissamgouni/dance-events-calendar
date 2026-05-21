/**
 * Phase E (E3) — onboarding gate.
 *
 * Wraps the routed content. If the current user is signed in and has
 * never completed onboarding (``onboarded_at == null``), redirects to
 * ``/onboarding/preferences?next=<current>`` exactly once per app load.
 *
 * Bypassed when:
 *   • user is anonymous (``user == null``);
 *   • auth is still loading;
 *   • current path is already under ``/onboarding`` (avoid loop);
 *   • current path is ``/login`` or ``/r/:code`` (entry flows that
 *     must not pre-empt redirects of their own);
 *   • current path starts with ``/admin`` (admins skip onboarding —
 *     they're typically existing internal users).
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const SKIP_PREFIXES = ['/onboarding', '/login', '/r/', '/admin', '/privacy'];

export default function OnboardingGate() {
    const { user, loading } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();

    useEffect(() => {
        if (loading || !user) return;
        if (user.onboarded_at) return;
        const path = location.pathname;
        if (SKIP_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p))) {
            // ``startsWith('/r/')`` catches the referral landing page.
            return;
        }
        const nextParam = encodeURIComponent(path + location.search);
        navigate(`/onboarding/preferences?next=${nextParam}`, { replace: true });
    }, [user, loading, location.pathname, location.search, navigate]);

    return null;
}
