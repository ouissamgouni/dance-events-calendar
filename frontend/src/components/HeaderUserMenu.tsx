import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { firstNameOf } from '../utils/displayName';
import { usePendingReviewCount } from '../hooks/usePendingReviewCount';
import MenuDrawer from './MenuDrawer';

/**
 * Header burger (☰) that opens the primary menu drawer from the right. Lives
 * top-right in the global header; shows the signed-in user's avatar beside the
 * burger. The drawer holds account identity + secondary destinations.
 */
export default function HeaderUserMenu({
    className,
    avatarOnly = false,
}: {
    className?: string;
    avatarOnly?: boolean;
}) {
    const { user } = useAuth();
    const [open, setOpen] = useState(false);
    const firstName = firstNameOf(user?.name);
    const pendingReviews = usePendingReviewCount();

    return (
        <div className={'shrink-0 ' + (className ?? '')}>
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={user ? `${firstName || 'Account'} menu${pendingReviews > 0 ? `, ${pendingReviews} to review` : ''}` : 'Menu'}
                aria-haspopup="dialog"
                aria-expanded={open}
                className="relative inline-flex items-center gap-1.5 h-11 px-1 -mr-1 text-ink-soft hover:text-ink transition"
            >
                {pendingReviews > 0 && (
                    // eslint-disable-next-line no-restricted-syntax -- status dot is circular by design
                    <span aria-hidden="true" className="absolute right-0 top-2 h-2 w-2 rounded-full bg-action" />
                )}
                {user && (
                    user.avatar_url ? (
                        <img
                            src={user.avatar_url}
                            alt=""
                            aria-hidden="true"
                            referrerPolicy="no-referrer"
                            className="h-8 w-8 rounded-full object-cover bg-canvas shrink-0"
                        />
                    ) : (
                        <span className="h-8 w-8 rounded-full bg-canvas text-ink-soft flex items-center justify-center text-sm font-semibold shrink-0">
                            {(firstName || user.name || '?').trim().charAt(0).toUpperCase()}
                        </span>
                    )
                )}
                {!avatarOnly && <img src="/menu.png" alt="" aria-hidden="true" className="h-6 w-6 object-contain" />}
            </button>
            <MenuDrawer open={open} onClose={() => setOpen(false)} />
        </div>
    );
}
