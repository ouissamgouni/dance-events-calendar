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
                    className="text-xs font-medium text-white hover:text-gray-200 transition"
                >
                    Settings
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
                className="inline-flex items-center text-xs font-medium text-white hover:text-gray-200 transition max-w-[8rem] truncate"
            >
                {firstName ?? 'Account'}
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
                        to="/my-calendar"
                        role="menuitem"
                        className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        My Calendar
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
