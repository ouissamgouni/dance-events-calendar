import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { fetchAuthMode, fetchDevUsers, requestEmailCode, type AuthMode, type DevUser } from '../../api';
import { getDeviceId } from '../../utils/deviceId';
import { trackLoginFailed, trackSignupStarted } from '../../utils/tracking';
import { SIGN_IN_BENEFITS, SIGN_IN_INTENT_COPY, mailAppFor, type SignInIntent } from './signInIntent';

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

const CODE_LENGTH = 6;
// GIS caps rendered button width at 400px.
const GOOGLE_MAX_WIDTH = 400;

interface Props {
    intent: SignInIntent;
    /** Hide logo + headline when the container (e.g. a sheet) already shows them. */
    showHeader?: boolean;
    onNotNow?: () => void;
}

export default function AuthPanel({ intent, showHeader = true, onNotNow }: Props) {
    const { user, loading, login, loginWithEmailCode } = useAuth();
    const buttonRef = useRef<HTMLDivElement>(null);
    const initialized = useRef(false);
    const [authMode, setAuthMode] = useState<AuthMode | null>(null);
    const [devUsers, setDevUsers] = useState<DevUser[]>([]);
    const [customEmail, setCustomEmail] = useState('');
    const [loginError, setLoginError] = useState<string | null>(null);

    const [emailOpen, setEmailOpen] = useState(false);
    const [emailStep, setEmailStep] = useState<'email' | 'code'>('email');
    const [emailValue, setEmailValue] = useState('');
    const [codeValue, setCodeValue] = useState('');
    const [codeFocused, setCodeFocused] = useState(false);
    const [codeTtlMin, setCodeTtlMin] = useState<number | null>(null);
    const [emailBusy, setEmailBusy] = useState(false);
    const [emailError, setEmailError] = useState<string | null>(null);
    const [devCode, setDevCode] = useState<string | null>(null);
    const [resendAt, setResendAt] = useState<number>(0);
    const [resendLeft, setResendLeft] = useState(0);

    useEffect(() => {
        if (resendAt <= 0) return;
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
                shape: 'rectangular',
                text: 'continue_with',
                logo_alignment: 'center',
                width: Math.min(GOOGLE_MAX_WIDTH, buttonRef.current.offsetWidth || GOOGLE_MAX_WIDTH),
            });
        }
    }, [loading, user, login, authMode]);

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
        setDevCode(null);
        trackSignupStarted('email');
        try {
            const res = await requestEmailCode(email);
            setEmailStep('code');
            setCodeValue('');
            setResendAt(Date.now() + 60_000);
            setCodeTtlMin(res.expires_in ? Math.round(res.expires_in / 60) : null);
            if (res.dev_code) setDevCode(res.dev_code);
        } catch (err) {
            setEmailError(err instanceof Error ? err.message : 'Could not send code');
        } finally {
            setEmailBusy(false);
        }
    };

    const verifyCode = async (code: string) => {
        const email = emailValue.trim().toLowerCase();
        if (!email || code.length !== CODE_LENGTH || emailBusy) return;
        setEmailBusy(true);
        setEmailError(null);
        try {
            await loginWithEmailCode(email, code, getDeviceId());
        } catch (err) {
            trackLoginFailed('email', 'code_invalid');
            setEmailError(err instanceof Error ? err.message : 'Invalid or expired code');
        } finally {
            setEmailBusy(false);
        }
    };

    const handleVerifyCode = (e: FormEvent) => {
        e.preventDefault();
        void verifyCode(codeValue.trim());
    };

    const handleCodeChange = (raw: string) => {
        const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
        setCodeValue(digits);
        setEmailError(null);
        if (digits.length === CODE_LENGTH) void verifyCode(digits);
    };

    const resetEmailFlow = () => {
        setEmailStep('email');
        setCodeValue('');
        setEmailError(null);
        setDevCode(null);
        setResendAt(0);
        setResendLeft(0);
    };

    if (loading || authMode === null) {
        return <p className="py-10 text-center text-sm text-muted">Loading…</p>;
    }

    const copy = SIGN_IN_INTENT_COPY[intent];
    const mailApp = emailStep === 'code' ? mailAppFor(emailValue.trim()) : null;
    const activeBox = Math.min(codeValue.length, CODE_LENGTH - 1);

    return (
        <div>
            {showHeader && (
                <div className="text-center">
                    <img src="/movida.png" alt="" aria-hidden="true" className="mx-auto h-12 w-12 object-contain" />
                    <h1 className="mt-3 text-2xl font-bold text-ink">{copy.headline}</h1>
                    <p className="mt-2 text-sm text-ink-soft">{copy.subtitle}</p>
                    {intent !== 'generic' && (
                        <p className="mt-1 text-xs text-ink-soft">Free account, no password.</p>
                    )}
                </div>
            )}

            {intent === 'generic' && emailStep === 'email' && (
                <ul className={`${showHeader ? 'mt-5' : ''} space-y-2 text-sm text-ink-soft`}>
                    {SIGN_IN_BENEFITS.map((benefit) => (
                        <li key={benefit} className="flex items-start gap-2.5">
                            <svg
                                viewBox="0 0 20 20"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                aria-hidden="true"
                                className="mt-0.5 h-4 w-4 flex-none text-action"
                            >
                                <path d="M4 10.5 8 14.5 16 5.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span>{benefit}</span>
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-6 flex flex-col items-center gap-3">
                {authMode.dev_auth ? emailStep === 'email' && (
                    <div className="flex w-full flex-col gap-3">
                        <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                            Dev mode (DEV_AUTH=true): no real Google verification.
                        </p>
                        {devUsers.length > 0 && (
                            <div className="flex flex-col gap-2">
                                {devUsers.map((u) => (
                                    <button
                                        key={u.email}
                                        onClick={() => handleDevLoginAs(u.email, u.name)}
                                        className="border border-line bg-surface px-4 py-2 text-left text-sm font-medium text-ink shadow-sm transition hover:bg-canvas"
                                    >
                                        Sign in as {u.name}
                                        <span className="ml-2 text-xs text-ink-soft">{u.email}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <form onSubmit={handleCustomDevLogin} className="flex flex-col gap-2">
                            <label className="text-xs text-ink-soft" htmlFor="dev-email">
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
                                    className="flex-1 border border-line px-3 py-2 text-sm"
                                />
                                <button
                                    type="submit"
                                    className="border border-line bg-surface px-3 py-2 text-sm font-medium text-ink shadow-sm transition hover:bg-canvas"
                                >
                                    Sign in
                                </button>
                            </div>
                        </form>
                        {loginError && <p className="text-sm text-danger">{loginError}</p>}
                    </div>
                ) : (
                    // Kept mounted during the code step: GIS renders into it only once.
                    <div ref={buttonRef} className={`${emailStep === 'code' ? 'hidden' : 'flex'} min-h-10 w-full max-w-[400px] justify-center`} />
                )}

                {emailStep === 'email' && !emailOpen && (
                    <button
                        type="button"
                        onClick={() => setEmailOpen(true)}
                        // eslint-disable-next-line no-restricted-syntax -- matches the 4px radius of Google's rendered button
                        className="flex h-10 w-full max-w-[400px] items-center justify-center gap-2 rounded border border-line bg-surface px-3 text-sm font-medium text-ink transition hover:bg-canvas"
                    >
                        <Mail aria-hidden className="h-[18px] w-[18px] text-ink-soft" strokeWidth={1.8} />
                        Continue with email
                    </button>
                )}

                {emailStep === 'email' && emailOpen && (
                    <form onSubmit={handleSendCode} className="flex w-full max-w-[400px] flex-col gap-2">
                        <label className="text-xs font-medium text-ink-soft" htmlFor="login-email">
                            Email address
                        </label>
                        <input
                            id="login-email"
                            type="email"
                            required
                            autoFocus
                            autoComplete="email"
                            value={emailValue}
                            onChange={(e) => setEmailValue(e.target.value)}
                            placeholder="you@example.com"
                            className="w-full rounded-field border border-line px-3 py-2 text-sm"
                        />
                        <button
                            type="submit"
                            disabled={emailBusy}
                            className="h-10 w-full rounded-field bg-action px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {emailBusy ? 'Sending…' : 'Email me a code'}
                        </button>
                    </form>
                )}

                {emailStep === 'code' && (
                    <form onSubmit={handleVerifyCode} className="flex w-full max-w-[400px] flex-col gap-3">
                        <div>
                            <h2 className="text-lg font-semibold text-ink">Check your email</h2>
                            <label htmlFor="login-code" className="mt-1 block text-sm text-ink-soft">
                                Enter the 6-digit code we sent to{' '}
                                <span className="font-medium text-ink">{emailValue.trim()}</span>
                            </label>
                            <button
                                type="button"
                                onClick={resetEmailFlow}
                                className="mt-1 text-sm font-medium text-action hover:underline"
                            >
                                Change email
                            </button>
                        </div>
                        <div className="relative">
                            <input
                                id="login-code"
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                pattern="\d{6}"
                                maxLength={CODE_LENGTH}
                                required
                                autoFocus
                                value={codeValue}
                                onChange={(e) => handleCodeChange(e.target.value)}
                                onFocus={() => setCodeFocused(true)}
                                onBlur={() => setCodeFocused(false)}
                                className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0"
                            />
                            <div aria-hidden="true" className="grid grid-cols-6 gap-2">
                                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                                    <div
                                        key={i}
                                        className={`flex h-12 items-center justify-center rounded-field border bg-surface font-mono text-xl font-semibold text-ink ${codeFocused && i === activeBox ? 'border-action ring-1 ring-action' : emailError ? 'border-danger' : 'border-line'
                                            }`}
                                    >
                                        {codeValue[i] ?? ''}
                                    </div>
                                ))}
                            </div>
                        </div>
                        {emailError && <p className="text-sm text-danger">{emailError}</p>}
                        <button
                            type="submit"
                            disabled={emailBusy || codeValue.length !== CODE_LENGTH}
                            className="h-10 w-full rounded-field bg-action px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {emailBusy ? 'Checking…' : 'Continue'}
                        </button>
                        {mailApp && (
                            <a
                                href={mailApp.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                // eslint-disable-next-line no-restricted-syntax -- matches the 4px radius of Google's rendered button
                                className="flex h-10 w-full items-center justify-center gap-2 rounded border border-line bg-surface text-sm font-medium text-ink transition hover:bg-canvas"
                            >
                                <Mail aria-hidden className="h-[18px] w-[18px] text-ink-soft" strokeWidth={1.8} />
                                {mailApp.label}
                            </a>
                        )}
                        <p className="text-xs text-ink-soft">
                            {codeTtlMin ? `The code expires in ${codeTtlMin} minutes. ` : ''}
                            Didn’t get it? Check your spam folder or{' '}
                            <button
                                type="button"
                                disabled={emailBusy || resendLeft > 0}
                                onClick={handleSendCode}
                                className="font-medium text-action hover:underline disabled:text-ink-soft disabled:no-underline"
                            >
                                {resendLeft > 0 ? `resend in ${resendLeft}s` : 'resend the code'}
                            </button>
                            .
                        </p>
                    </form>
                )}

                {emailStep === 'email' && emailError && <p className="w-full max-w-[400px] text-sm text-danger">{emailError}</p>}
                {devCode && (
                    <p className="w-full max-w-[400px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        Dev mode: your code is <strong className="font-mono">{devCode}</strong>
                    </p>
                )}
            </div>

            {onNotNow && (
                <div className="mt-4 text-center">
                    <button type="button" onClick={onNotNow} className="min-h-9 px-3 text-sm font-medium text-ink-soft hover:text-ink">
                        Not now
                    </button>
                </div>
            )}

            <p className="mt-6 text-center text-xs text-ink-soft">
                By continuing you agree to the{' '}
                <Link to="/terms" className="underline hover:text-ink">Terms</Link> and acknowledge the{' '}
                <Link to="/privacy" className="underline hover:text-ink">Privacy Policy</Link>.
                Movida is for people aged 16 and over. With Google, we receive your name, email and profile photo.
            </p>
        </div>
    );
}
