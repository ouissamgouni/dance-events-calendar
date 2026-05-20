import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import MineButton from './MineButton';
import FollowsButton from './FollowsButton';

/**
 * Always-visible floating Mine CTA at the bottom-right of the viewport.
 * Wraps `MineButton` so the floater and the fixed top-bar entry point
 * share the same label, counts, icons, and navigation target.
 *
 * - Visible on every route where the FAB makes sense (including `/`).
 * - Hidden on routes where it would be redundant (`/my-calendar`) or out of
 *   place (admin, login, shared, privacy).
 * - Has an inline dismiss button: clicking × hides the floater for the
 *   remainder of the session (sessionStorage-backed). Reload to bring it
 *   back.
 */
const DISMISS_KEY = 'floatingMineButton.dismissed';

export default function FloatingMineButton() {
    const location = useLocation();
    const [dismissed, setDismissed] = useState<boolean>(() => {
        if (typeof window === 'undefined') return false;
        return window.sessionStorage.getItem(DISMISS_KEY) === '1';
    });

    const path = location.pathname;
    const showOnRoute = path === '/' || path === '/calendar';
    if (!showOnRoute) return null;
    if (dismissed) return null;

    const handleDismiss = () => {
        setDismissed(true);
        try { window.sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore quota */ }
    };

    return (
        <div className="fixed bottom-4 right-4 z-[8000] flex items-center shadow-lg">
            <MineButton />
            <div className="border-l border-slate-100">
                <FollowsButton />
            </div>
            <button
                type="button"
                onClick={handleDismiss}
                aria-label="Hide"
                className="ml-px bg-white text-slate-400 hover:text-slate-700 px-1.5 py-1 text-sm leading-none border-l border-slate-100"
            >
                ×
            </button>
        </div>
    );
}
