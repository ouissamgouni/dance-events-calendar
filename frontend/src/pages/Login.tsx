import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { fetchAuthMode, fetchDevUsers, type AuthMode, type DevUser } from '../api';
import { getDeviceId } from '../utils/deviceId';

declare global {
    interface Window {
        google?: {
            accounts: {
                id: {
                    initialize: (config: Record<string, unknown>) => void;
                    renderButton: (el: HTMLElement, config: Record<string, unknown>) => void;
                };
            };
        };
    }
}

export default function Login() {
    const { user, loading, login } = useAuth();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const nextParam = searchParams.get('next');
    const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : null;
    const buttonRef = useRef<HTMLDivElement>(null);
    const initialized = useRef(false);
    const [authMode, setAuthMode] = useState<AuthMode | null>(null);
    const [devUsers, setDevUsers] = useState<DevUser[]>([]);
    const [customEmail, setCustomEmail] = useState('');
    const [loginError, setLoginError] = useState<string | null>(null);

    useEffect(() => {
        fetchAuthMode().then(setAuthMode).catch(() => setAuthMode({ dev_auth: false, google_client_id: '' }));
    }, []);

    useEffect(() => {
        if (authMode?.dev_auth) {
            fetchDevUsers().then(setDevUsers).catch(() => setDevUsers([]));
        }
    }, [authMode]);

    useEffect(() => {
        if (!loading && user) {
            const dest = safeNext ?? (user.is_admin ? '/admin' : '/account');
            navigate(dest, { replace: true });
        }
    }, [user, loading, navigate, safeNext]);

    // Google Identity Services init (only when we have a client ID)
    useEffect(() => {
        if (loading || user || initialized.current || !authMode || authMode.dev_auth) return;

        const clientId = authMode.google_client_id;
        if (!clientId || !window.google) return;

        initialized.current = true;

        window.google.accounts.id.initialize({
            client_id: clientId,
            callback: async (response: { credential: string }) => {
                try {
                    await login(response.credential, getDeviceId());
                    // Destination is computed by the redirect effect once `user` updates.
                } catch {
                    // Token verification failed — button stays visible to retry
                }
            },
        });

        if (buttonRef.current) {
            window.google.accounts.id.renderButton(buttonRef.current, {
                theme: 'outline',
                size: 'large',
                text: 'signin_with',
            });
        }
    }, [loading, user, login, navigate, authMode]);

    const handleDevLoginAs = async (email: string, name?: string) => {
        setLoginError(null);
        try {
            await login('dev-credential', getDeviceId(), email, name);
        } catch {
            setLoginError(`Sign-in as ${email} failed`);
        }
    };

    const handleCustomDevLogin = async (e: FormEvent) => {
        e.preventDefault();
        const email = customEmail.trim().toLowerCase();
        if (!email) return;
        await handleDevLoginAs(email);
    };

    if (loading || authMode === null) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <p className="text-slate-400">Loading…</p>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
            <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>
            <p className="text-sm text-slate-500">
                Sign in with Google to sync your bookmarks and “I’m going” events across devices.
            </p>

            {authMode.dev_auth ? (
                <div className="flex w-full max-w-sm flex-col gap-4">
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                        Dev mode (DEV_AUTH=true): no real Google verification.
                    </p>
                    {devUsers.length > 0 && (
                        <div className="flex flex-col gap-2">
                            {devUsers.map((u) => (
                                <button
                                    key={u.email}
                                    onClick={() => handleDevLoginAs(u.email, u.name)}
                                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition text-left"
                                >
                                    Sign in as {u.name}
                                    <span className="ml-2 text-xs text-slate-400">{u.email}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    <form onSubmit={handleCustomDevLogin} className="flex flex-col gap-2">
                        <label className="text-xs text-slate-500">Or sign in as another email:</label>
                        <div className="flex gap-2">
                            <input
                                type="email"
                                required
                                value={customEmail}
                                onChange={(e) => setCustomEmail(e.target.value)}
                                placeholder="user@example.com"
                                className="flex-1 rounded border border-slate-300 px-3 py-1.5 text-sm"
                            />
                            <button
                                type="submit"
                                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
                            >
                                Sign in
                            </button>
                        </div>
                    </form>
                    {loginError && <p className="text-sm text-rose-600">{loginError}</p>}
                </div>
            ) : (
                <div ref={buttonRef} />
            )}
        </div>
    );
}
