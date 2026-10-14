import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useSavedEvents } from './SavedEventsContext';
import { useAttendingEvents } from './AttendingEventsContext';
import { useToast } from '../components/Toast';
import AuthSheet from '../components/auth/AuthSheet';
import { signInPath, type SignInIntent } from '../components/auth/signInIntent';
import {
    clearPendingAuth,
    currentScrollTop,
    readPendingAuth,
    samePage,
    savePendingAuth,
    updatePendingAuth,
    type PendingAuthAction,
} from '../components/auth/pendingAuth';
import { defaultRsvpAudienceFor, defaultSavedAudienceFor } from '../utils/audiencePreference';

export interface OpenSignInOptions {
    /** Save / Going to complete once signed in (persisted across redirects). */
    action?: PendingAuthAction;
    /** In-page follow-up (e.g. reopen a composer); never publishes anything. */
    onSignedIn?: () => void;
}

type OpenSignIn = (intent?: SignInIntent, options?: OpenSignInOptions) => void;

const SignInSheetContext = createContext<OpenSignIn | null>(null);

const SCROLL_RETRY_MS = 100;
const SCROLL_RETRIES = 20;

function fullPath(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
    return `${location.pathname}${location.search}${location.hash}`;
}

// Pages the user passes through while signing in; the return context survives them.
function isAuthDetour(pathname: string): boolean {
    return pathname === '/login' || pathname.startsWith('/onboarding');
}

function restoreScroll(target: number) {
    let tries = 0;
    const tick = () => {
        const main = document.querySelector('main');
        if (!main) return;
        main.scrollTop = target;
        // Content may still be loading; retry until the page is tall enough.
        if (Math.abs(main.scrollTop - target) > 2 && tries++ < SCROLL_RETRIES) window.setTimeout(tick, SCROLL_RETRY_MS);
    };
    window.requestAnimationFrame(tick);
}

export function SignInSheetProvider({ children }: { children: ReactNode }) {
    const { user, loading: authLoading } = useAuth();
    const saved = useSavedEvents();
    const attending = useAttendingEvents();
    const toast = useToast();
    const location = useLocation();
    const [intent, setIntent] = useState<SignInIntent | null>(null);
    const locationRef = useRef(location);
    const onSignedInRef = useRef<(() => void) | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const openPathRef = useRef<string | null>(null);
    const detourRef = useRef(false);
    const resumingRef = useRef(false);
    const staleCheckedRef = useRef(false);

    useEffect(() => {
        locationRef.current = location;
    });

    const restoreFocus = useCallback(() => {
        const el = returnFocusRef.current;
        returnFocusRef.current = null;
        if (el?.isConnected) window.requestAnimationFrame(() => el.focus());
    }, []);

    const open = useCallback<OpenSignIn>((next = 'generic', options) => {
        const loc = locationRef.current;
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        onSignedInRef.current = options?.onSignedIn ?? null;
        openPathRef.current = loc.pathname;
        savePendingAuth({ intent: next, action: options?.action, returnTo: fullPath(loc), scrollTop: currentScrollTop() });
        setIntent(next);
    }, []);

    const dismiss = useCallback(() => {
        clearPendingAuth();
        onSignedInRef.current = null;
        setIntent(null);
        restoreFocus();
    }, [restoreFocus]);

    // Signing in (from the sheet or elsewhere) closes it and runs the in-page follow-up.
    const [signInsWhileOpen, setSignInsWhileOpen] = useState(0);
    if (user && intent) {
        setIntent(null);
        setSignInsWhileOpen((n) => n + 1);
    }
    useEffect(() => {
        if (!signInsWhileOpen) return;
        const followUp = onSignedInRef.current;
        onSignedInRef.current = null;
        restoreFocus();
        followUp?.();
    }, [signInsWhileOpen, restoreFocus]);

    // Leaving the page (e.g. the Terms link) abandons the prompt.
    useEffect(() => {
        if (intent && openPathRef.current !== location.pathname) dismiss();
    }, [location.pathname, intent, dismiss]);

    // A guest reloading mid-prompt never finished signing in: drop the stale intent.
    useEffect(() => {
        if (authLoading || staleCheckedRef.current) return;
        staleCheckedRef.current = true;
        if (!user && !isAuthDetour(locationRef.current.pathname)) clearPendingAuth();
    }, [authLoading, user]);

    // Complete the explicitly requested Save / Going once, after server state has synced.
    useEffect(() => {
        if (!user || !saved.ready || !attending.ready || resumingRef.current) return;
        const action = readPendingAuth()?.action;
        if (!action) return;
        resumingRef.current = true;
        updatePendingAuth({ action: undefined });
        const run = async () => {
            if (action.kind === 'save') {
                if (saved.isSaved(action.eventId)) {
                    toast.push({ title: 'Already in your plans', message: action.eventTitle, variant: 'success' });
                    return;
                }
                const ok = await saved.toggleSave(action.eventId, defaultSavedAudienceFor(user));
                toast.push(ok
                    ? { title: 'Saved to your plans', message: action.eventTitle, variant: 'success' }
                    : { title: 'Couldn’t save — try again', message: action.eventTitle, variant: 'error' });
                return;
            }
            if (attending.isAttending(action.eventId)) {
                toast.push({ title: action.isPast ? 'Already marked as attended' : 'You’re already going', message: action.eventTitle, variant: 'success' });
                return;
            }
            const ok = await attending.toggleAttending(action.eventId, defaultRsvpAudienceFor(user));
            toast.push(ok
                ? { title: action.isPast ? 'You attended' : 'You’re going', message: action.eventTitle, variant: 'success' }
                : { title: 'Couldn’t mark you as going — try again', message: action.eventTitle, variant: 'error' });
        };
        void run().finally(() => { resumingRef.current = false; });
    }, [user, saved, attending, toast]);

    // After a /login or onboarding detour, return the user to where they were scrolled.
    useEffect(() => {
        if (isAuthDetour(location.pathname)) {
            detourRef.current = true;
            return;
        }
        if (!user) return;
        const pending = readPendingAuth();
        if (!pending) return;
        if (samePage(fullPath(location), pending.returnTo)) {
            if (!detourRef.current) return;
            detourRef.current = false;
            if (pending.scrollTop > 0) restoreScroll(pending.scrollTop);
        }
        if (pending.action) updatePendingAuth({ returnTo: '', scrollTop: 0 });
        else clearPendingAuth();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per navigation only
    }, [location.key]);

    return (
        <SignInSheetContext.Provider value={open}>
            {children}
            {intent && <AuthSheet intent={intent} onClose={dismiss} />}
        </SignInSheetContext.Provider>
    );
}

/** Opens the sign-in sheet, or navigates to /login when no provider is mounted. */
export function useSignIn(): OpenSignIn {
    const open = useContext(SignInSheetContext);
    const navigate = useNavigate();
    const location = useLocation();
    return useMemo<OpenSignIn>(
        () => open ?? ((intent = 'generic', options) => {
            const returnTo = fullPath(location);
            savePendingAuth({ intent, action: options?.action, returnTo, scrollTop: currentScrollTop() });
            navigate(signInPath(returnTo, intent));
        }),
        [open, navigate, location],
    );
}
