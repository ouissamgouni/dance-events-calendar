import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { firstNameOf } from '../utils/displayName';
import { NAV_DESTINATIONS } from './navDestinations';

/**
 * Header "More" (☰) menu. Holds secondary destinations that don't live in the
 * primary nav: Dance Passport, Submit Event, Install App, Settings, Logout
 * (plus Admin for admins, Invite friends). Logged-out users get a dedicated
 * "Sign in" link beside the burger, whose menu offers Submit / Install /
 * Settings.
 */
export default function HeaderUserMenu({ className }: { className?: string }) {
    const { user, logout } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, []);

    // Close on route change.
    useEffect(() => {
        setOpen(false);
    }, [location.pathname]);

    const isAdminPage = location.pathname.startsWith('/admin');
    const firstName = firstNameOf(user?.name);

    const onLogout = async () => {
        setOpen(false);
        try {
            await logout();
        } finally {
            navigate('/');
        }
    };

    const itemClass = 'flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50';
    const iconClass = 'h-4 w-4 object-contain shrink-0';

    return (
        <div ref={ref} className={'relative inline-flex items-center gap-2 ' + (className ?? '')}>
            {!user && (
                <Link
                    to="/login"
                    className="text-sm font-medium text-white hover:text-gray-200 transition"
                >
                    Sign in
                </Link>
            )}
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-label={user ? `${firstName || 'Account'} account menu` : 'Menu'}
                aria-haspopup="menu"
                aria-expanded={open}
                className="inline-flex items-center gap-2 text-white hover:text-gray-200 transition"
            >
                {user && <span className="text-sm truncate">{firstName || 'Account'}</span>}
                <img
                    src="/menu.png"
                    alt=""
                    aria-hidden="true"
                    className="h-5 w-5 object-contain"
                    style={{ filter: 'brightness(0) invert(1)' }}
                />
            </button>

            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-full mt-1 w-48 bg-white border border-slate-200 shadow-lg z-50 py-1"
                >
                    <div className="md:hidden">
                        {NAV_DESTINATIONS.map((dest) => (
                            <Link
                                key={dest.id}
                                to={dest.path}
                                role="menuitem"
                                aria-current={dest.isActive(location.pathname) ? 'page' : undefined}
                                className={itemClass}
                            >
                                <img src={dest.icon} alt="" aria-hidden="true" className={iconClass} />
                                {dest.label}
                            </Link>
                        ))}
                        <div className="my-1 border-t border-slate-100" role="separator" />
                    </div>
                    {user ? (
                        <>
                            <Link to="/mine/passport" role="menuitem" className={itemClass}>
                                <img src="/passport.png" alt="" aria-hidden="true" className={iconClass} />
                                Dance Passport
                            </Link>
                            <div className="my-1 border-t border-slate-100" role="separator" />
                            <Link to="/?submit=1" role="menuitem" onClick={() => setOpen(false)} className={itemClass}>
                                <img src="/schedule.png" alt="" aria-hidden="true" className={iconClass} />
                                Submit Event
                            </Link>
                            <Link to="/invite" role="menuitem" className={itemClass}>
                                <img src="/add-user.png" alt="" aria-hidden="true" className={iconClass} />
                                Invite friends
                            </Link>
                            <Link to="/install" role="menuitem" className={itemClass}>
                                <img src="/save.png" alt="" aria-hidden="true" className={iconClass} />
                                Install App
                            </Link>
                            <div className="my-1 border-t border-slate-100" role="separator" />
                            <Link to="/account" role="menuitem" className={itemClass}>
                                <img src="/setting.png" alt="" aria-hidden="true" className={iconClass} />
                                Settings
                            </Link>
                            {user.is_admin && (
                                <Link to={isAdminPage ? '/' : '/admin'} role="menuitem" className={itemClass}>
                                    <img src="/setting.png" alt="" aria-hidden="true" className={iconClass} />
                                    {isAdminPage ? 'Explore' : 'Admin'}
                                </Link>
                            )}
                            <button type="button" onClick={onLogout} role="menuitem" className={itemClass + ' w-full text-left'}>
                                <img src="/quit.png" alt="" aria-hidden="true" className={iconClass} />
                                Logout
                            </button>
                        </>
                    ) : (
                        <>
                            <Link to="/?submit=1" role="menuitem" onClick={() => setOpen(false)} className={itemClass}>
                                <img src="/schedule.png" alt="" aria-hidden="true" className={iconClass} />
                                Submit Event
                            </Link>
                            <Link to="/install" role="menuitem" className={itemClass}>
                                <img src="/save.png" alt="" aria-hidden="true" className={iconClass} />
                                Install App
                            </Link>
                            <div className="my-1 border-t border-slate-100" role="separator" />
                            <Link to="/account" role="menuitem" className={itemClass}>
                                <img src="/setting.png" alt="" aria-hidden="true" className={iconClass} />
                                Settings
                            </Link>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
