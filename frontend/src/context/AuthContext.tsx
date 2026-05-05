import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
    deleteMyAccount as apiDeleteMe,
    fetchMe,
    loginWithGoogle as apiLogin,
    logout as apiLogout,
    type AuthUser,
} from '../api';
import { rotateDeviceId } from '../utils/deviceId';
import { clearUmamiBaseContext, setUmamiBaseContext, umamiIdentify } from '../utils/umami';
import {
    trackLoginCompleted,
    trackLogout,
    trackSignupCompleted,
    type AuthMethod,
} from '../utils/tracking';

export type User = AuthUser;

interface AuthContextType {
    user: User | null;
    loading: boolean;
    login: (
        credential: string,
        deviceId?: string,
        mockEmail?: string,
        mockName?: string,
    ) => Promise<void>;
    logout: () => Promise<void>;
    deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    // Monotonic generation counter so a stale in-flight fetchMe cannot
    // overwrite a more recent login()/logout()/deleteAccount() result.
    const generation = useRef(0);

    useEffect(() => {
        const gen = ++generation.current;
        fetchMe()
            .then((u) => {
                if (generation.current === gen) {
                    setUser(u);
                    // Restore Umami session identity on page reload (no event fired —
                    // this is not a new login, just session restoration).
                    if (u.user_id) umamiIdentify(u.user_id);
                    setUmamiBaseContext({ is_authenticated: true });
                }
            })
            .catch(() => {
                if (generation.current === gen) setUser(null);
            })
            .finally(() => {
                if (generation.current === gen) setLoading(false);
            });
    }, []);

    const login = useCallback(async (
        credential: string,
        deviceId?: string,
        mockEmail?: string,
        mockName?: string,
    ) => {
        // Bump the generation FIRST so any in-flight fetchMe can no longer
        // overwrite the user state we are about to set.
        generation.current++;
        const u = await apiLogin(credential, deviceId, mockEmail, mockName);
        setUser(u);
        setLoading(false);
        // Analytics: distinguish first-time signup from returning login, then
        // identify the Umami session by internal user id (no PII).
        const method: AuthMethod = mockEmail ? 'dev' : 'google';
        if (u.is_new_user) {
            trackSignupCompleted(method);
        } else {
            trackLoginCompleted(method);
        }
        if (u.user_id) umamiIdentify(u.user_id);
        setUmamiBaseContext({ is_authenticated: true, auth_method: method });
    }, []);

    const logout = useCallback(async () => {
        generation.current++;
        trackLogout();
        await apiLogout();
        // Rotate the anonymous device identity so the next sign-in on this
        // browser (potentially a different user) cannot inherit anonymous
        // activity that happened during this user's session.
        rotateDeviceId();
        clearUmamiBaseContext();
        setUser(null);
    }, []);

    const deleteAccount = useCallback(async () => {
        generation.current++;
        await apiDeleteMe();
        rotateDeviceId();
        clearUmamiBaseContext();
        setUser(null);
    }, []);

    return (
        <AuthContext.Provider value={{ user, loading, login, logout, deleteAccount }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextType {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
