import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags, useFeatureFlagsReady } from '../context/FeatureFlagsContext';

const PUBLIC_EXACT_PATHS = new Set(['/login', '/privacy', '/invite', '/install']);
const PUBLIC_PATH_PREFIXES = ['/r/', '/event/', '/series/', '/u/', '/shared/'];

function isPublicPath(pathname: string): boolean {
    return PUBLIC_EXACT_PATHS.has(pathname)
        || PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export default function AppAccessGate({ children }: { children: React.ReactNode }) {
    const { user, loading: authLoading } = useAuth();
    const { appAuthGateEnabled } = useFeatureFlags();
    const featureFlagsReady = useFeatureFlagsReady();
    const location = useLocation();

    if (user || isPublicPath(location.pathname)) return <>{children}</>;

    if (authLoading || !featureFlagsReady) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-canvas">
                <p className="text-muted">Loading…</p>
            </div>
        );
    }

    if (appAuthGateEnabled) {
        const next = encodeURIComponent(
            `${location.pathname}${location.search}${location.hash}`,
        );
        return <Navigate to={`/login?next=${next}`} replace />;
    }

    if (location.pathname === '/') {
        return (
            <Navigate
                to={{ pathname: '/browse', search: location.search, hash: location.hash }}
                replace
            />
        );
    }

    return <>{children}</>;
}
