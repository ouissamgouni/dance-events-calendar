import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Shortcut CTA that jumps to the "From people I follow" calendar view
 * (`/my-calendar/subscriptions`). Mirrors `MineButton` shape & sizing so
 * the two read as a pair in the explorer toolbar and inside the floating
 * pill. Anonymous users are routed through sign-in.
 */
export default function FollowsButton() {
    const { user } = useAuth();
    const target = '/my-calendar/subscriptions';
    const to = user ? target : `/login?next=${encodeURIComponent(target)}`;

    return (
        <Link
            to={to}
            data-testid="follows-button"
            aria-label="Open the calendar from people I follow"
            title="Calendar from people I follow"
            className="inline-flex items-center gap-1.5 px-2 py-1 text-sm bg-white text-slate-900 font-medium shadow-sm hover:bg-slate-50 transition"
        >
            {/* Two-people icon (matches the "Following" filter pill in Home.tsx) */}
            <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="w-3.5 h-3.5 text-slate-700"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <circle cx="7" cy="7" r="3" />
                <path d="M2 17c0-2.8 2.2-5 5-5s5 2.2 5 5" />
                <circle cx="14" cy="6" r="2.4" />
                <path d="M13 12c2.8 0 5 2 5 5" />
            </svg>
            <span className="hidden sm:inline">Follows</span>
        </Link>
    );
}
