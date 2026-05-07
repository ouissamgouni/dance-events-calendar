import { Link, useLocation } from 'react-router-dom';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useScrollDirection } from '../hooks/useScrollDirection';

/**
 * Mobile-only floating "Mine" CTA that links to the user's personal calendar.
 * - Hidden on desktop (sm:+)
 * - Hidden on routes where it would be redundant or out of place
 * - Slides out of view while the user scrolls down, returns on scroll up
 */
export default function MyCalendarFab() {
    const location = useLocation();
    const { savedCount } = useSavedEvents();
    const { attendingCount } = useAttendingEvents();
    const hidden = useScrollDirection();

    // Hide on routes where the FAB doesn't make sense
    const path = location.pathname;
    const hideOnRoute =
        path === '/my-calendar' ||
        path.startsWith('/admin') ||
        path.startsWith('/login') ||
        path.startsWith('/shared') ||
        path.startsWith('/privacy');
    if (hideOnRoute) return null;

    const total = savedCount + attendingCount;

    return (
        <Link
            to="/my-calendar"
            aria-label={`Open My Calendar${total > 0 ? ` (${total} event${total !== 1 ? 's' : ''})` : ''}`}
            className={`sm:hidden fixed bottom-4 right-4 z-[8000] inline-flex items-center gap-2 bg-blue-500 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-blue-600 transition-all duration-200 ${hidden ? 'translate-y-24 opacity-0 pointer-events-none' : 'translate-y-0 opacity-100'
                }`}
        >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
            </svg>
            <span>Mine</span>
            {total > 0 && (
                <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 bg-white text-blue-600 text-[11px] font-semibold">
                    {total}
                </span>
            )}
        </Link>
    );
}
