import { useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import AuthPanel from '../components/auth/AuthPanel';
import { resolveSignInIntent } from '../components/auth/signInIntent';

export default function Login() {
    const { user, loading } = useAuth();
    const { appAuthGateEnabled } = useOptionalFeatureFlags();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const nextParam = searchParams.get('next');
    const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : null;
    const intent = resolveSignInIntent(searchParams.get('intent'), safeNext);

    useEffect(() => {
        if (!loading && user) {
            const dest = user.is_admin ? '/admin' : (safeNext ?? '/');
            navigate(dest, { replace: true });
        }
    }, [user, loading, navigate, safeNext]);

    // "default" key = /login was the first page of this session, so there's nothing to go back to.
    const handleNotNow = () => (location.key !== 'default' ? navigate(-1) : navigate('/'));

    return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10 sm:py-16">
            <div className="w-full max-w-md">
                <div className="rounded-card border border-card-line bg-surface p-6 shadow-sm sm:p-8">
                    <AuthPanel intent={intent} onNotNow={appAuthGateEnabled ? undefined : handleNotNow} />
                </div>
            </div>
        </div>
    );
}
