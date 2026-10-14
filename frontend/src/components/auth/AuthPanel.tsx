import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CalendarDays, Mail, Users } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { fetchAuthMode, fetchDevUsers, requestEmailCode, type AuthMode, type DevUser } from '../../api';
import { getDeviceId } from '../../utils/deviceId';
import { trackLoginFailed, trackSignupStarted } from '../../utils/tracking';
import { SIGN_IN_BENEFITS, mailAppFor } from './signInIntent';

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
const GIS_WAIT_MS = 8000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BENEFIT_ICONS = [CalendarDays, Users, Bell];

const PRIMARY_BUTTON =
    'flex h-[52px] w-full items-center justify-center gap-3 rounded-auth-button bg-auth-navy px-4 text-base font-semibold text-white transition hover:bg-auth-navy-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-action/35 disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON =
    'flex h-[52px] w-full items-center justify-center gap-3 rounded-auth-button border border-auth-border bg-surface px-4 text-base font-semibold text-auth-navy transition hover:bg-canvas focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-action/35';
const FIELD =
    'h-[52px] w-full rounded-auth-button border bg-surface px-4 text-base text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-[3px] focus:ring-action/35';

interface Props {
    /** ``page`` adds the benefit strip; ``sheet`` stays compact. */
    variant: 'page' | 'sheet';
    headline: string;
    subtitle: string;
    headingId?: string;
    subtitleId?: string;
    onKeepBrowsing?: () => void;
}

export default function AuthPanel({ variant, headline, subtitle, headingId, subtitleId, onKeepBrowsing }: Props) {
    const { user, loading, login, loginWithEmailCode } = useAuth();
    const uid = useId();
    const emailErrorId = `${uid}-email-error`;
    const buttonRef = useRef<HTMLDivElement>(null);
    const initialized = useRef(false);
    const [authMode, setAuthMode] = useState<AuthMode | null>(null);
    const [gisLoaded, setGisLoaded] = useState(() => typeof window !== 'undefined' && !!window.google);
    const [googleBusy, setGoogleBusy] = useState(false);
    const [googleError, setGoogleError] = useState<string | null>(null);
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

    // The GIS script loads async; wait for it instead of silently rendering no button.
    useEffect(() => {
        if (gisLoaded || !authMode?.google_client_id || authMode.dev_auth) return;
        const started = Date.now();
        const id = window.setInterval(() => {
            if (window.google) {
                setGisLoaded(true);
                window.clearInterval(id);
            } else if (Date.now() - started > GIS_WAIT_MS) {
                setGoogleError('Google sign-in couldn’t load. Check your connection or continue with email.');
                window.clearInterval(id);
            }
        }, 200);
        return () => window.clearInterval(id);
    }, [gisLoaded, authMode]);

    useEffect(() => {
        if (loading || user || initialized.current || !authMode || authMode.dev_auth || !gisLoaded) return;

        const clientId = authMode.google_client_id;
        if (!clientId || !window.google) return;

        initialized.current = true;

        window.google.accounts.id.initialize({
            client_id: clientId,
            callback: async (response: { credential: string }) => {
                trackSignupStarted('google');
                setGoogleError(null);
                setGoogleBusy(true);
                try {
                    await login(response.credential, getDeviceId());
                } catch {
                    trackLoginFailed('google', 'token_invalid');
                    setGoogleError('Google sign-in didn’t complete. Please try again.');
                } finally {
                    setGoogleBusy(false);
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
    }, [loading, user, login, authMode, gisLoaded]);

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
        if (emailBusy) return;
        if (!EMAIL_RE.test(email)) {
            setEmailError('Enter a valid email address, like name@example.com.');
            return;
        }
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

    const Heading = variant === 'page' ? 'h1' : 'h2';
    const mailApp = emailStep === 'code' ? mailAppFor(emailValue.trim()) : null;
    const activeBox = Math.min(codeValue.length, CODE_LENGTH - 1);
    const ready = !loading && authMode !== null;
    const isPage = variant === 'page';

    return (
        <div>
            <div className="text-center">
                <Heading
                    id={headingId}
                    className={isPage
                        ? 'text-balance text-[36px] font-extrabold leading-[1.1] tracking-[-0.035em] text-auth-navy'
                        : 'text-balance text-[28px] font-bold leading-[1.15] tracking-tight text-auth-navy'}
                >
                    {headline}
                </Heading>
                <p
                    id={subtitleId}
                    className={`text-balance text-auth-muted ${isPage ? 'mx-auto mt-4 max-w-[340px] text-lg leading-[1.55]' : 'mt-3 text-base leading-6'}`}
                >
                    {subtitle}
                </p>
                <p className={`text-auth-muted ${isPage ? 'mt-6 text-[15px] font-medium' : 'mt-4 text-sm'}`}>
                    Free account · No password.
                </p>
            </div>

            {!ready || !authMode ? (
                <p role="status" className="py-10 text-center text-sm text-auth-muted">Loading…</p>
            ) : (
                <div className={`${isPage ? 'mt-8' : 'mt-6'} flex flex-col gap-3`}>
                    {authMode.dev_auth ? emailStep === 'email' && (
                        <div className="flex w-full flex-col gap-3">
                            <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                                Dev mode (DEV_AUTH=true): no real Google verification.
                            </p>
                            {devUsers.length > 0 && (
                                <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
                                    {devUsers.map((u) => (
                                        <button
                                            key={u.email}
                                            type="button"
                                            onClick={() => handleDevLoginAs(u.email, u.name)}
                                            className="rounded-auth-button border border-auth-border bg-surface px-4 py-2 text-left text-sm font-medium text-ink transition hover:bg-canvas"
                                        >
                                            Sign in as {u.name}
                                            <span className="ml-2 text-xs text-ink-soft">{u.email}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            <form onSubmit={handleCustomDevLogin} className="flex flex-col gap-2">
                                <label className="text-xs text-ink-soft" htmlFor={`${uid}-dev-email`}>
                                    Or sign in as another email:
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        id={`${uid}-dev-email`}
                                        type="email"
                                        required
                                        value={customEmail}
                                        onChange={(e) => setCustomEmail(e.target.value)}
                                        placeholder="user@example.com"
                                        className="flex-1 rounded-auth-button border border-auth-border px-3 py-2 text-sm"
                                    />
                                    <button
                                        type="submit"
                                        className="rounded-auth-button border border-auth-border bg-surface px-3 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
                                    >
                                        Sign in
                                    </button>
                                </div>
                            </form>
                            {loginError && <p role="alert" className="text-sm text-danger">{loginError}</p>}
                        </div>
                    ) : (
                        // Kept mounted during the code step: GIS renders into it only once.
                        <div className={`${emailStep === 'code' ? 'hidden' : 'flex'} h-[52px] w-full items-center justify-center`}>
                            <div ref={buttonRef} className="flex w-full max-w-[400px] justify-center" />
                        </div>
                    )}

                    {googleBusy && (
                        <p role="status" className="text-center text-sm text-auth-muted">Signing you in…</p>
                    )}
                    {googleError && emailStep === 'email' && (
                        <p role="alert" className="text-center text-sm text-danger">{googleError}</p>
                    )}

                    {emailStep === 'email' && !emailOpen && (
                        <button type="button" onClick={() => setEmailOpen(true)} className={PRIMARY_BUTTON}>
                            <Mail aria-hidden className="h-6 w-6" strokeWidth={1.8} />
                            Continue with email
                        </button>
                    )}

                    {emailStep === 'email' && emailOpen && (
                        <form onSubmit={handleSendCode} noValidate className="flex w-full flex-col gap-2">
                            <label className="text-left text-sm font-medium text-auth-navy" htmlFor={`${uid}-email`}>
                                Email address
                            </label>
                            <input
                                id={`${uid}-email`}
                                type="email"
                                required
                                autoFocus
                                autoComplete="email"
                                inputMode="email"
                                value={emailValue}
                                onChange={(e) => { setEmailValue(e.target.value); setEmailError(null); }}
                                placeholder="you@example.com"
                                aria-invalid={emailError ? true : undefined}
                                aria-describedby={emailError ? emailErrorId : undefined}
                                className={`${FIELD} ${emailError ? 'border-danger' : 'border-auth-border'}`}
                            />
                            {emailError && <p id={emailErrorId} role="alert" className="text-left text-sm text-danger">{emailError}</p>}
                            <button type="submit" disabled={emailBusy} className={`${PRIMARY_BUTTON} mt-1`}>
                                {emailBusy ? 'Sending…' : 'Email me a code'}
                            </button>
                        </form>
                    )}

                    {emailStep === 'code' && (
                        <form onSubmit={handleVerifyCode} className="flex w-full flex-col gap-3 text-left">
                            <div>
                                <h3 className="text-lg font-semibold text-auth-navy">Check your email</h3>
                                <label htmlFor={`${uid}-code`} className="mt-1 block text-sm text-auth-muted">
                                    Enter the 6-digit code we sent to{' '}
                                    <span className="font-medium text-auth-navy">{emailValue.trim()}</span>
                                </label>
                                <button
                                    type="button"
                                    onClick={resetEmailFlow}
                                    className="mt-1 min-h-9 text-sm font-semibold text-action-strong hover:underline"
                                >
                                    Change email
                                </button>
                            </div>
                            <div className="relative">
                                <input
                                    id={`${uid}-code`}
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
                                    aria-invalid={emailError ? true : undefined}
                                    aria-describedby={emailError ? emailErrorId : undefined}
                                    className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0"
                                />
                                <div aria-hidden="true" className="grid grid-cols-6 gap-2">
                                    {Array.from({ length: CODE_LENGTH }, (_, i) => (
                                        <div
                                            key={i}
                                            className={`flex h-[52px] items-center justify-center rounded-auth-button border bg-surface font-mono text-xl font-semibold text-auth-navy ${codeFocused && i === activeBox ? 'border-action ring-[3px] ring-action/35' : emailError ? 'border-danger' : 'border-auth-border'
                                                }`}
                                        >
                                            {codeValue[i] ?? ''}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {emailError && <p id={emailErrorId} role="alert" className="text-sm text-danger">{emailError}</p>}
                            <button
                                type="submit"
                                disabled={emailBusy || codeValue.length !== CODE_LENGTH}
                                className={PRIMARY_BUTTON}
                            >
                                {emailBusy ? 'Checking…' : 'Continue'}
                            </button>
                            {mailApp && (
                                <a href={mailApp.href} target="_blank" rel="noopener noreferrer" className={SECONDARY_BUTTON}>
                                    <Mail aria-hidden className="h-5 w-5" strokeWidth={1.8} />
                                    {mailApp.label}
                                </a>
                            )}
                            <p className="text-sm text-auth-muted">
                                {codeTtlMin ? `The code expires in ${codeTtlMin} minutes. ` : ''}
                                Didn’t get it? Check your spam folder or{' '}
                                <button
                                    type="button"
                                    disabled={emailBusy || resendLeft > 0}
                                    onClick={handleSendCode}
                                    className="font-semibold text-action-strong hover:underline disabled:font-normal disabled:text-auth-muted disabled:no-underline"
                                >
                                    {resendLeft > 0 ? `resend in ${resendLeft}s` : 'resend the code'}
                                </button>
                                .
                            </p>
                        </form>
                    )}

                    {devCode && (
                        <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                            Dev mode: your code is <strong className="font-mono">{devCode}</strong>
                        </p>
                    )}
                </div>
            )}

            {onKeepBrowsing && (
                <div className={`${isPage ? 'mt-5' : 'mt-3'} flex justify-center`}>
                    <button
                        type="button"
                        onClick={onKeepBrowsing}
                        className={`min-h-11 px-4 font-semibold text-action hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-action/35 ${isPage ? 'text-[17px]' : 'text-base'}`}
                    >
                        Keep browsing
                    </button>
                </div>
            )}

            <hr className={`${isPage ? 'my-8' : 'my-6'} border-auth-border/70`} />

            {isPage && (
                <>
                    <ul aria-label="With a free account" className="grid grid-cols-3 rounded-card bg-auth-tint py-6">
                        {SIGN_IN_BENEFITS.map((benefit, i) => {
                            const Icon = BENEFIT_ICONS[i];
                            return (
                                <li
                                    key={benefit}
                                    className={`flex flex-col items-center gap-2.5 px-2 text-center text-base font-medium leading-tight text-auth-navy ${i > 0 ? 'border-l border-auth-border/70' : ''}`}
                                >
                                    <Icon aria-hidden className="h-7 w-7" strokeWidth={1.6} />
                                    {benefit}
                                </li>
                            );
                        })}
                    </ul>
                    <hr className="my-8 border-auth-border/70" />
                </>
            )}

            <p className={`text-center text-auth-muted ${isPage ? 'text-sm leading-[1.65]' : 'text-[13px] leading-5'}`}>
                By continuing, you agree to the{' '}
                <Link to="/terms" className="underline hover:text-auth-navy">Terms</Link> and acknowledge the{' '}
                <Link to="/privacy" className="underline hover:text-auth-navy">Privacy Policy</Link>.
                Ages 16+. With Google, we receive your name, email and profile photo.
            </p>
        </div>
    );
}
