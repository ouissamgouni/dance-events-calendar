/**
 * Phase E (E3) — onboarding gate.
 *
 * Wraps the routed content. If the current user is signed in and the
 * server flags them as needing onboarding (``needs_onboarding === true``,
 * which covers both "never onboarded" and "server bumped the wizard
 * version"), redirects to ``/onboarding/preferences?next=<current>``
 * exactly once per app load. Preferences is the first onboarding leg
 * (dance styles + reach); the local step follows so users pin a home
 * area after selecting tags.
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
        // Prefer the server-computed ``needs_onboarding`` flag (covers
        // both never-onboarded users and forced re-onboarding after a
        // wizard-version bump). Fall back to ``onboarded_at`` so a
        // stale cached response without the new field still gates
        // first-time users correctly.
        const needs =
            typeof user.needs_onboarding === 'boolean'
                ? user.needs_onboarding
                : !user.onboarded_at;
        if (!needs) return;
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
