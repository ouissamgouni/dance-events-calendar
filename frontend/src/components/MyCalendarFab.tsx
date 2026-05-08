import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import SavedEventsFab from './SavedEventsFab';

/**
 * Always-visible floating "Mine" CTA at the bottom-right of the viewport.
 * Wraps `SavedEventsFab` so the floater and the fixed top-bar entry point
 * are literally the same UI — same label, same badges, same click target
 * (navigates straight to `/my-calendar`).
 *
 * - Visible on every route where the FAB makes sense (including `/`).
 * - Hidden on routes where it would be redundant (`/my-calendar`) or out of
 *   place (admin, login, shared, privacy).
 * - Has an inline dismiss button: clicking × hides the floater for the
 *   remainder of the session (sessionStorage-backed). Reload to bring it
 *   back.
 */
const DISMISS_KEY = 'myCalendarFab.dismissed';

export default function MyCalendarFab() {
    const location = useLocation();
    const { savedEventIds } = useSavedEvents();
    const { attendingEventIds } = useAttendingEvents();
    const [dismissed, setDismissed] = useState<boolean>(() => {
        if (typeof window === 'undefined') return false;
        return window.sessionStorage.getItem(DISMISS_KEY) === '1';
    });

    const path = location.pathname;
    const hideOnRoute =
        path === '/my-calendar' ||
        path.startsWith('/admin') ||
        path.startsWith('/login') ||
        path.startsWith('/shared') ||
        path.startsWith('/privacy');
    if (hideOnRoute) return null;
    if (dismissed) return null;

    const total = new Set([...savedEventIds, ...attendingEventIds]).size;
    if (total === 0) return null;

    const handleDismiss = () => {
        setDismissed(true);
        try { window.sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore quota */ }
    };

    return (
        <div className="fixed bottom-4 right-4 z-[8000] flex items-center shadow-lg">
            <SavedEventsFab />
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
