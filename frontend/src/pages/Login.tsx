import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { fetchAuthMode, type AuthMode } from '../api';

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
    const buttonRef = useRef<HTMLDivElement>(null);
    const initialized = useRef(false);
    const [authMode, setAuthMode] = useState<AuthMode | null>(null);

    useEffect(() => {
        fetchAuthMode().then(setAuthMode).catch(() => setAuthMode({ dev_auth: false, google_client_id: '' }));
    }, []);

    useEffect(() => {
        if (!loading && user) {
            navigate('/admin', { replace: true });
        }
    }, [user, loading, navigate]);

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
                    await login(response.credential);
                    navigate('/admin', { replace: true });
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

    const handleDevLogin = async () => {
        try {
            await login('dev-credential');
            navigate('/admin', { replace: true });
        } catch {
            // ignore
        }
    };

    if (loading || authMode === null) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <p className="text-slate-400">Loading…</p>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-6">
            <h1 className="text-2xl font-bold text-slate-900">Admin Login</h1>
            <p className="text-sm text-slate-500">Sign in with your Google account to manage calendars.</p>

            {authMode.dev_auth ? (
                <button
                    onClick={handleDevLogin}
                    className="rounded-lg border border-slate-300 bg-white px-6 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
                >
                    Dev Login
                </button>
            ) : (
                <div ref={buttonRef} />
            )}
        </div>
    );
}
