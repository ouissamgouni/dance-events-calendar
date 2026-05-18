import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
    deleteMyAccount as apiDeleteMe,
    fetchMe,
    loginWithGoogle as apiLogin,
    logout as apiLogout,
    type AuthUser,
    type PreferredAreaPayload,
} from '../api';
import { rotateDeviceId } from '../utils/deviceId';
import { clearUmamiBaseContext, setAnalyticsDisabled, setUmamiBaseContext, umamiIdentify } from '../utils/umami';
import {
    trackLoginCompleted,
    trackLogout,
    trackSignupCompleted,
    type AuthMethod,
} from '../utils/tracking';

export type User = AuthUser;

/**
 * Mirrors the storage key in {@link ../context/PreferencesContext}. Duplicated
 * here — rather than imported — to avoid an Auth↔Preferences provider
 * cycle. Bump both call sites together if the key version changes.
 */
const PREFS_STORAGE_KEY = 'movida.preferences.v1';

function readAnonPreferencesFromStorage():
    | { preferred_area: PreferredAreaPayload | null; preferred_tag_ids: number[] }
    | null {
    try {
        const raw = localStorage.getItem(PREFS_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
            preferred_area?: PreferredAreaPayload | null;
            preferred_tag_ids?: unknown;
        };
        const area = parsed.preferred_area && typeof parsed.preferred_area === 'object'
            ? parsed.preferred_area
            : null;
        const tagIds = Array.isArray(parsed.preferred_tag_ids)
            ? parsed.preferred_tag_ids.filter((x): x is number => typeof x === 'number')
            : [];
        if (!area && tagIds.length === 0) return null;
        return { preferred_area: area, preferred_tag_ids: tagIds };
    } catch {
        return null;
    }
}

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
    /** Re-fetch the current user. Use after mutations that change
     * server-side preferences (e.g. PATCH /auth/preferences) so all
     * consumers re-render without a full page reload. */
    refreshUser: () => Promise<void>;
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
                    // Exclude admin sessions from analytics entirely (Umami
                    // load, page views, custom events, and server-side
                    // /track/* POSTs) so moderation activity does not skew
                    // product KPIs.
                    setAnalyticsDisabled(u.is_admin === true);
                    if (u.is_admin === true) {
                        clearUmamiBaseContext();
                    } else {
                        // Restore Umami session identity on page reload (no event fired —
                        // this is not a new login, just session restoration).
                        if (u.user_id) umamiIdentify(u.user_id);
                        setUmamiBaseContext({ is_authenticated: true });
                    }
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
        // Surface anonymous preferences (preferred area + tags) saved by the
        // user before signing in. Read straight from localStorage so we don't
        // create an Auth↔Preferences context cycle. The backend silently
        // ignores this payload when the user already has server-side prefs.
        const anonPrefs = readAnonPreferencesFromStorage();
        const u = await apiLogin(credential, deviceId, mockEmail, mockName, anonPrefs);
        setUser(u);
        setLoading(false);
        // Admin sessions are excluded from analytics — see fetchMe handler above.
        setAnalyticsDisabled(u.is_admin === true);
        if (u.is_admin === true) {
            clearUmamiBaseContext();
            return;
        }
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
        setAnalyticsDisabled(false);
        setUser(null);
    }, []);

    const deleteAccount = useCallback(async () => {
        generation.current++;
        await apiDeleteMe();
        rotateDeviceId();
        clearUmamiBaseContext();
        setAnalyticsDisabled(false);
        setUser(null);
    }, []);

    const refreshUser = useCallback(async () => {
        const gen = ++generation.current;
        try {
            const u = await fetchMe();
            if (generation.current === gen) setUser(u);
        } catch {
            // Leave existing user state intact on failure; the next
            // auto-load on next mount will reconcile.
        }
    }, []);

    // Phase E (E2): when a follow/unfollow happens anywhere in the app
    // (notifications "Follow back", profile follow button, network panel
    // remove), the user's ``friend_count`` may have changed — re-fetch
    // /auth/me so the AudiencePicker zero-friends hint and any other
    // friend-count-driven UI immediately reflect the new graph.
    useEffect(() => {
        const onNetworkChanged = () => {
            if (user) void refreshUser();
        };
        window.addEventListener('network:changed', onNetworkChanged);
        return () =>
            window.removeEventListener('network:changed', onNetworkChanged);
    }, [user, refreshUser]);

    return (
        <AuthContext.Provider value={{ user, loading, login, logout, deleteAccount, refreshUser }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextType {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
