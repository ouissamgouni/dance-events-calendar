import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAnyOverlayOpen } from '../hooks/useBackToClose';
import HomeReviewPrompt from './HomeReviewPrompt';
import HomePeoplePrompt from './HomePeoplePrompt';

// Task flows, auth/onboarding, shared pages and legal pages never get an interruptive sheet.
const BLOCKED_ROUTES =
    /^\/(admin|login|onboarding|install|shared|r|suggest|privacy|terms|legal)(\/|$)|^\/event\/[^/]+\/(review|ticket|memories|program|ask|suggest-change)(\/|$)/;
// Deep-link landings (push, email, share) wait for an in-app navigation or this dwell.
const DEEP_LINK_DWELL_MS = 20_000;

/** App-wide host for the review wizard and the people sheet (review first, one per session). */
export default function AppPrompts() {
    const { user } = useAuth();
    const location = useLocation();
    const overlayOpen = useAnyOverlayOpen();
    const [landingKey] = useState(location.key);
    const [landedHome] = useState(location.pathname === '/');
    const [dwelled, setDwelled] = useState(false);
    const [reviewSettled, setReviewSettled] = useState(false);
    const onReviewSettled = useCallback(() => setReviewSettled(true), []);

    useEffect(() => {
        if (landedHome) return;
        const timer = window.setTimeout(() => setDwelled(true), DEEP_LINK_DWELL_MS);
        return () => window.clearTimeout(timer);
    }, [landedHome]);

    if (!user) return null;
    const ready = landedHome || dwelled || location.key !== landingKey;
    const canStart = ready && !overlayOpen && !BLOCKED_ROUTES.test(location.pathname);
    const userId = user.user_id ?? user.email;

    return (
        <>
            <HomeReviewPrompt userId={userId} enabled={canStart} onSettled={onReviewSettled} />
            <HomePeoplePrompt userId={userId} enabled={canStart && reviewSettled} />
        </>
    );
}
