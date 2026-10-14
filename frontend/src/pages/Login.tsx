import { useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import AuthPanel from '../components/auth/AuthPanel';
import { FULL_PAGE_COPY, SIGN_IN_INTENT_COPY, resolveSignInIntent } from '../components/auth/signInIntent';
import { clearPendingAuth } from '../components/auth/pendingAuth';

export default function Login() {
    const { user, loading } = useAuth();
    const { appAuthGateEnabled } = useOptionalFeatureFlags();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const nextParam = searchParams.get('next');
    const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : null;
    const intent = resolveSignInIntent(searchParams.get('intent'), safeNext);
    const copy = intent === 'generic' ? FULL_PAGE_COPY : SIGN_IN_INTENT_COPY[intent];

    useEffect(() => {
        if (!loading && user) {
            const dest = user.is_admin ? '/admin' : (safeNext ?? '/');
            navigate(dest, { replace: true });
        }
    }, [user, loading, navigate, safeNext]);

    // "default" key = /login was the first page of this session, so there's nothing to go back to.
    const handleKeepBrowsing = () => {
        clearPendingAuth();
        if (location.key !== 'default') navigate(-1);
        else navigate('/');
    };
    const dismissible = !appAuthGateEnabled;

    return (
        <div className="min-h-full bg-surface">
            <div className="mx-auto w-full max-w-[440px] px-6 pt-[calc(16px+env(safe-area-inset-top))] pb-[calc(32px+env(safe-area-inset-bottom))]">
                <div className="flex h-14 items-center justify-between">
                    <div className="flex items-center gap-2">
                        <img src="/icons/logo-transparent-bg.png" alt="" aria-hidden="true" className="-ml-1.5 h-12 w-12 object-contain" />
                        <span className="text-[28px] font-extrabold leading-none tracking-[-0.03em] text-auth-navy">Movida</span>
                    </div>
                    {dismissible && (
                        <button
                            type="button"
                            onClick={handleKeepBrowsing}
                            aria-label="Close"
                            className="-mr-2 flex h-11 w-11 items-center justify-center text-auth-navy transition hover:bg-canvas focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-action/35"
                        >
                            <X aria-hidden className="h-7 w-7" strokeWidth={1.8} />
                        </button>
                    )}
                </div>
                <div className="mt-12 sm:mt-16">
                    <AuthPanel
                        variant="page"
                        headline={copy.headline}
                        subtitle={copy.subtitle}
                        onKeepBrowsing={dismissible ? handleKeepBrowsing : undefined}
                    />
                </div>
            </div>
        </div>
    );
}
