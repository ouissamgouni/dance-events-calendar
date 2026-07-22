import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { fetchAuthMode, fetchDevUsers, requestEmailCode, type AuthMode, type DevUser } from '../api';
import { getDeviceId } from '../utils/deviceId';
import { trackLoginFailed, trackSignupStarted } from '../utils/tracking';

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
    const { user, loading, login, loginWithEmailCode } = useAuth();
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

    // Email one-time-code flow.
    const [emailStep, setEmailStep] = useState<'email' | 'code'>('email');
    const [emailValue, setEmailValue] = useState('');
    const [codeValue, setCodeValue] = useState('');
    const [emailBusy, setEmailBusy] = useState(false);
    const [emailError, setEmailError] = useState<string | null>(null);
    const [emailNotice, setEmailNotice] = useState<string | null>(null);
    const [devCode, setDevCode] = useState<string | null>(null);
    const [resendAt, setResendAt] = useState<number>(0);
    const [resendLeft, setResendLeft] = useState(0);

    useEffect(() => {
        if (resendAt <= 0) {
            setResendLeft(0);
            return;
        }
        const tick = () => setResendLeft(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)));
        tick();
        const id = window.setInterval(tick, 500);
        return () => window.clearInterval(id);
    }, [resendAt]);

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
            const dest = safeNext ?? (user.is_admin ? '/admin' : '/');
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
                trackSignupStarted('google');
                try {
                    await login(response.credential, getDeviceId());
                    // Destination is computed by the redirect effect once `user` updates.
                } catch {
                    // Token verification failed — button stays visible to retry
                    trackLoginFailed('google', 'token_invalid');
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
        trackSignupStarted('dev');
        try {
            await login('dev-credential', getDeviceId(), email, name);
        } catch {
            trackLoginFailed('dev', 'request_failed');
            setLoginError(`Sign-in as ${email} failed`);
        }
    };

    const handleCustomDevLogin = async (e: FormEvent) => {
        e.preventDefault();
        const email = customEmail.trim().toLowerCase();
        if (!email) return;
        await handleDevLoginAs(email);
    };

    const handleSendCode = async (e: FormEvent) => {
        e.preventDefault();
        const email = emailValue.trim().toLowerCase();
        if (!email || emailBusy) return;
        setEmailBusy(true);
        setEmailError(null);
        setEmailNotice(null);
        setDevCode(null);
        trackSignupStarted('email');
        try {
            const res = await requestEmailCode(email);
            setEmailStep('code');
            setResendAt(Date.now() + 60_000);
            if (res.dev_code) {
                setDevCode(res.dev_code);
            } else {
                setEmailNotice(`We sent a 6-digit code to ${email}.`);
            }
        } catch (err) {
            setEmailError(err instanceof Error ? err.message : 'Could not send code');
        } finally {
            setEmailBusy(false);
        }
    };

    const handleVerifyCode = async (e: FormEvent) => {
        e.preventDefault();
        const email = emailValue.trim().toLowerCase();
        const code = codeValue.trim();
        if (!email || !code || emailBusy) return;
        setEmailBusy(true);
        setEmailError(null);
        try {
            await loginWithEmailCode(email, code, getDeviceId());
            // Destination is computed by the redirect effect once `user` updates.
        } catch (err) {
            trackLoginFailed('email', 'code_invalid');
            setEmailError(err instanceof Error ? err.message : 'Invalid or expired code');
        } finally {
            setEmailBusy(false);
        }
    };

    const resetEmailFlow = () => {
        setEmailStep('email');
        setCodeValue('');
        setEmailError(null);
        setEmailNotice(null);
        setDevCode(null);
        setResendAt(0);
    };

    if (loading || authMode === null) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-slate-50">
                <p className="text-slate-400">Loading…</p>
            </div>
        );
    }

    const benefits = [
        'Bookmark events and get reminders',
        'See who else is going and share your calendar',
        'Rate events and get picks tailored to you',
    ];

    return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 sm:py-16">
            <div className="w-full max-w-md">
                <div className="border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
                    <div className="text-center">
                        <h1 className="text-2xl font-bold text-slate-900">Sign in to Movida</h1>
                        <p className="mt-2 text-sm text-slate-500">
                            Save events, see who’s going, and sync everything across your devices.
                        </p>
                    </div>

                    <ul className="mt-6 space-y-2.5 text-sm text-slate-600">
                        {benefits.map((benefit) => (
                            <li key={benefit} className="flex items-start gap-2.5">
                                <svg
                                    viewBox="0 0 20 20"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    aria-hidden="true"
                                    className="mt-0.5 h-4 w-4 flex-none text-blue-500"
                                >
                                    <path d="M4 10.5 8 14.5 16 5.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                <span>{benefit}</span>
                            </li>
                        ))}
                    </ul>

                    <div className="mt-6 flex flex-col gap-4">
                        {authMode.dev_auth ? (
                            <div className="flex flex-col gap-3">
                                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                                    Dev mode (DEV_AUTH=true): no real Google verification.
                                </p>
                                {devUsers.length > 0 && (
                                    <div className="flex flex-col gap-2">
                                        {devUsers.map((u) => (
                                            <button
                                                key={u.email}
                                                onClick={() => handleDevLoginAs(u.email, u.name)}
                                                className="border border-slate-200 bg-white px-4 py-2 text-left text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                                            >
                                                Sign in as {u.name}
                                                <span className="ml-2 text-xs text-slate-400">{u.email}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <form onSubmit={handleCustomDevLogin} className="flex flex-col gap-2">
                                    <label className="text-xs text-slate-500" htmlFor="dev-email">
                                        Or sign in as another email:
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            id="dev-email"
                                            type="email"
                                            required
                                            value={customEmail}
                                            onChange={(e) => setCustomEmail(e.target.value)}
                                            placeholder="user@example.com"
                                            className="flex-1 border border-slate-300 px-3 py-2 text-sm"
                                        />
                                        <button
                                            type="submit"
                                            className="border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                                        >
                                            Sign in
                                        </button>
                                    </div>
                                </form>
                                {loginError && <p className="text-sm text-rose-600">{loginError}</p>}
                            </div>
                        ) : (
                            <div ref={buttonRef} className="flex justify-center" />
                        )}

                        <div className="flex items-center gap-3 text-xs text-slate-400">
                            <span className="h-px flex-1 bg-slate-200" />
                            or
                            <span className="h-px flex-1 bg-slate-200" />
                        </div>

                        {emailStep === 'email' ? (
                            <form onSubmit={handleSendCode} className="flex flex-col gap-2">
                                <label className="text-xs font-medium text-slate-500" htmlFor="login-email">
                                    Sign in with an email code
                                </label>
                                <input
                                    id="login-email"
                                    type="email"
                                    required
                                    autoComplete="email"
                                    value={emailValue}
                                    onChange={(e) => setEmailValue(e.target.value)}
                                    placeholder="you@example.com"
                                    className="w-full border border-slate-300 px-3 py-2 text-sm"
                                />
                                <button
                                    type="submit"
                                    disabled={emailBusy}
                                    className="w-full bg-blue-500 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {emailBusy ? 'Sending…' : 'Send code'}
                                </button>
                            </form>
                        ) : (
                            <form onSubmit={handleVerifyCode} className="flex flex-col gap-3">
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-xs font-medium text-slate-500" htmlFor="login-code">
                                        Enter the 6-digit code
                                    </label>
                                    <input
                                        id="login-code"
                                        type="text"
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        pattern="\d{6}"
                                        maxLength={6}
                                        required
                                        autoFocus
                                        value={codeValue}
                                        onChange={(e) => setCodeValue(e.target.value.replace(/\D/g, ''))}
                                        placeholder="••••••"
                                        className="w-full border border-slate-300 px-3 py-2.5 text-center font-mono text-xl tracking-[0.5em]"
                                    />
                                </div>
                                <button
                                    type="submit"
                                    disabled={emailBusy}
                                    className="w-full bg-blue-500 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {emailBusy ? 'Verifying…' : 'Verify & sign in'}
                                </button>
                                <div className="flex items-center justify-between text-xs text-slate-500">
                                    <button
                                        type="button"
                                        onClick={resetEmailFlow}
                                        className="underline hover:text-slate-700"
                                    >
                                        Use a different email
                                    </button>
                                    <button
                                        type="button"
                                        disabled={emailBusy || resendLeft > 0}
                                        onClick={handleSendCode}
                                        className="underline hover:text-slate-700 disabled:no-underline disabled:opacity-50"
                                    >
                                        {resendLeft > 0 ? `Resend in ${resendLeft}s` : 'Resend code'}
                                    </button>
                                </div>
                            </form>
                        )}
                        {emailNotice && <p className="text-sm text-slate-600">{emailNotice}</p>}
                        {devCode && (
                            <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                                Dev mode: your code is <strong className="font-mono">{devCode}</strong>
                            </p>
                        )}
                        {emailError && <p className="text-sm text-rose-600">{emailError}</p>}
                    </div>
                </div>
            </div>
        </div>
    );
}
