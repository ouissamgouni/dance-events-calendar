import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Header account control. When the user is logged out, renders inline
 * **Settings** and **Sign in** links (Settings isn't discoverable behind a
 * generic trigger, so it stays visible). When logged in, collapses to a
 * single first-name button that opens a Settings / My Calendar / Admin /
 * Logout menu.
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
    const firstName = user?.name?.split(' ')[0];

    const onLogout = async () => {
        setOpen(false);
        try {
            await logout();
        } finally {
            navigate('/');
        }
    };

    if (!user) {
        return (
            <div className={'flex items-center gap-3 ' + (className ?? '')}>
                <Link
                    to="/account"
                    aria-label="Settings"
                    title="Settings"
                    className="text-xs font-medium text-white hover:text-gray-200 transition inline-flex items-center"
                >
                    <img
                        src="/menu.png"
                        alt=""
                        aria-hidden="true"
                        className="sm:hidden h-4 w-4 object-contain"
                        style={{ filter: 'brightness(0) invert(1)' }}
                    />
                    <span className="hidden sm:inline">Settings</span>
                </Link>
                <Link
                    to="/login"
                    className="text-xs font-medium text-white hover:text-gray-200 transition"
                >
                    Sign in
                </Link>
            </div>
        );
    }

    return (
        <div ref={ref} className={'relative ' + (className ?? '')}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded={open}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-white hover:text-gray-200 transition max-w-[9rem]"
            >
                <span className="truncate">{firstName ?? 'Account'}</span>
                <img
                    src="/menu.png"
                    alt=""
                    aria-hidden="true"
                    className="h-4 w-4 object-contain shrink-0"
                    style={{ filter: 'brightness(0) invert(1)' }}
                />
            </button>

            {open && (
                <div
                    role="menu"
                    className="absolute right-0 mt-1 w-44 bg-white border border-slate-200 shadow-lg z-50 py-1"
                >

                    <Link
                        to="/account"
                        role="menuitem"
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        Settings
                    </Link>
                    <Link
                        to="/for-you"
                        role="menuitem"
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        For You
                    </Link>
                    <Link
                        to="/my-calendar"
                        role="menuitem"
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        My Calendar
                    </Link>
                    <Link
                        to="/my-calendar/subscriptions"
                        role="menuitem"
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        My tribe events
                    </Link>
                    <Link
                        to="/discover"
                        role="menuitem"
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        Find people
                    </Link>
                    <Link
                        to="/account#network"
                        role="menuitem"
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        Invite friends
                    </Link>
                    <Link
                        to="/?submit=1"
                        role="menuitem"
                        onClick={() => setOpen(false)}
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        Submit event
                    </Link>
                    {user.is_admin && (
                        <Link
                            to={isAdminPage ? '/' : '/admin'}
                            role="menuitem"
                            className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                        >
                            {isAdminPage ? 'Explorer' : 'Admin'}
                        </Link>
                    )}
                    <Link
                        to="/install"
                        role="menuitem"
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        Install app
                    </Link>
                    <button
                        type="button"
                        onClick={onLogout}
                        role="menuitem"
                        className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 border-t border-slate-100"
                    >
                        Logout
                    </button>
                </div>
            )}
        </div>
    );
}
