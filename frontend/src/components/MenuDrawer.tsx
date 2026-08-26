import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { firstNameOf } from '../utils/displayName';
import { useNavDestinations } from './navDestinations';

/**
 * Primary menu drawer opened by the header burger (top-right). Holds the
 * account identity, primary destinations (mobile) and secondary actions (Dance
 * Passport, Submit Event, Settings, Admin, Logout). Slides in from the right.
 */
export default function MenuDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { user, logout } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const navDestinations = useNavDestinations();

    // Close on route change and on Escape.
    useEffect(() => {
        onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.pathname]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const isAdminPage = location.pathname.startsWith('/admin');
    const firstName = firstNameOf(user?.name);
    const profilePath = user?.handle ? `/u/${user.handle}` : '/account';

    const onLogout = async () => {
        onClose();
        try {
            await logout();
        } finally {
            navigate('/');
        }
    };

    const rowClass =
        'flex items-center gap-3 h-[52px] px-5 text-sm text-ink hover:bg-canvas transition';
    const iconClass = 'h-[22px] w-[22px] object-contain shrink-0';
    const divider = <div className="my-2 border-t border-line" role="separator" />;

    return (
        <div className="fixed inset-0 z-[9000]" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={onClose} />
            <div
                className="absolute right-0 top-0 bottom-0 w-[85vw] max-w-[360px] bg-surface shadow-2xl animate-slide-right flex flex-col overflow-y-auto"
                style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
                {user ? (
                    <Link
                        to={profilePath}
                        onClick={onClose}
                        className="flex items-center gap-3 px-5 py-4 border-b border-line hover:bg-canvas transition"
                    >
                        {user.avatar_url ? (
                            <img
                                src={user.avatar_url}
                                alt=""
                                aria-hidden="true"
                                className="h-11 w-11 rounded-full object-cover bg-canvas shrink-0"
                            />
                        ) : (
                            <div className="h-11 w-11 rounded-full bg-canvas text-ink-soft flex items-center justify-center text-base font-semibold shrink-0">
                                {(firstName || user.name || '?').trim().charAt(0).toUpperCase()}
                            </div>
                        )}
                        <div className="min-w-0">
                            <div className="text-base font-semibold text-ink truncate">{firstName || 'Account'}</div>
                            <div className="text-xs font-medium text-action">View profile</div>
                        </div>
                    </Link>
                ) : (
                    <div className="px-5 py-4 border-b border-line">
                        <Link
                            to="/login"
                            onClick={onClose}
                            className="flex items-center justify-center w-full bg-action px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition"
                        >
                            Sign in
                        </Link>
                    </div>
                )}

                <nav aria-label="Menu" className="py-2">
                    <div className="md:hidden">
                        {navDestinations.map((dest) => (
                            <Link
                                key={dest.id}
                                to={dest.path}
                                onClick={onClose}
                                aria-current={dest.isActive(location.pathname) ? 'page' : undefined}
                                className={rowClass}
                            >
                                <img src={dest.icon} alt="" aria-hidden="true" className={iconClass} />
                                {dest.label}
                            </Link>
                        ))}
                        {divider}
                    </div>

                    {user ? (
                        <>
                            <Link to="/mine/passport" onClick={onClose} className={rowClass}>
                                <img src="/passport.png" alt="" aria-hidden="true" className={iconClass} />
                                Dance Passport
                            </Link>
                            {divider}
                            <Link to="/?submit=1" onClick={onClose} className={rowClass}>
                                <img src="/schedule.png" alt="" aria-hidden="true" className={iconClass} />
                                Submit Event
                            </Link>
                            <Link to="/invite" onClick={onClose} className={rowClass}>
                                <img src="/add-user.png" alt="" aria-hidden="true" className={iconClass} />
                                Invite friends
                            </Link>
                            <Link to="/install" onClick={onClose} className={rowClass}>
                                <img src="/save.png" alt="" aria-hidden="true" className={iconClass} />
                                Install App
                            </Link>
                            {divider}
                            <Link to="/account" onClick={onClose} className={rowClass}>
                                <img src="/setting.png" alt="" aria-hidden="true" className={iconClass} />
                                Settings
                            </Link>
                            {user.is_admin && (
                                <Link to={isAdminPage ? '/' : '/admin'} onClick={onClose} className={rowClass}>
                                    <img src="/setting.png" alt="" aria-hidden="true" className={iconClass} />
                                    {isAdminPage ? 'Explore' : 'Admin'}
                                </Link>
                            )}
                            <button type="button" onClick={onLogout} className={rowClass + ' w-full text-left text-danger'}>
                                <img src="/quit.png" alt="" aria-hidden="true" className={iconClass} />
                                Logout
                            </button>
                        </>
                    ) : (
                        <>
                            <Link to="/?submit=1" onClick={onClose} className={rowClass}>
                                <img src="/schedule.png" alt="" aria-hidden="true" className={iconClass} />
                                Submit Event
                            </Link>
                            <Link to="/install" onClick={onClose} className={rowClass}>
                                <img src="/save.png" alt="" aria-hidden="true" className={iconClass} />
                                Install App
                            </Link>
                            {divider}
                            <Link to="/account" onClick={onClose} className={rowClass}>
                                <img src="/setting.png" alt="" aria-hidden="true" className={iconClass} />
                                Settings
                            </Link>
                        </>
                    )}
                </nav>
            </div>
        </div>
    );
}
