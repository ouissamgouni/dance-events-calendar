import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import BottomSheet from '../components/BottomSheet';
import AuthPanel from '../components/auth/AuthPanel';
import { SIGN_IN_INTENT_COPY, signInPath, type SignInIntent } from '../components/auth/signInIntent';

type OpenSignIn = (intent?: SignInIntent) => void;

const SignInSheetContext = createContext<OpenSignIn | null>(null);

export function SignInSheetProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const [intent, setIntent] = useState<SignInIntent | null>(null);

    // Signing in (from the sheet or elsewhere) dismisses it.
    if (user && intent) setIntent(null);

    const open = useCallback<OpenSignIn>((next = 'generic') => setIntent(next), []);
    const close = useCallback(() => setIntent(null), []);
    const copy = intent ? SIGN_IN_INTENT_COPY[intent] : null;

    return (
        <SignInSheetContext.Provider value={open}>
            {children}
            {intent && copy && (
                <BottomSheet
                    title={copy.headline}
                    subtitle={copy.subtitle}
                    titleSize="large"
                    variant="floating"
                    desktop="modal"
                    layer="transient"
                    onClose={close}
                >
                    <AuthPanel intent={intent} showHeader={false} onNotNow={close} />
                </BottomSheet>
            )}
        </SignInSheetContext.Provider>
    );
}

/** Opens the sign-in sheet, or navigates to /login when no provider is mounted. */
export function useSignIn(): OpenSignIn {
    const open = useContext(SignInSheetContext);
    const navigate = useNavigate();
    const location = useLocation();
    return useMemo<OpenSignIn>(
        () => open ?? ((intent = 'generic') => navigate(signInPath(`${location.pathname}${location.search}${location.hash}`, intent))),
        [open, navigate, location.pathname, location.search, location.hash],
    );
}
