import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute({
    children,
    requireAdmin = false,
}: {
    children: React.ReactNode;
    requireAdmin?: boolean;
}) {
    const { user, loading } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <p className="text-muted">Loading…</p>
            </div>
        );
    }

    if (!user) {
        const next = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);
        return <Navigate to={`/login?next=${next}`} replace />;
    }

    if (requireAdmin && user.is_admin !== true) {
        return <Navigate to="/" replace />;
    }

    return <>{children}</>;
}
