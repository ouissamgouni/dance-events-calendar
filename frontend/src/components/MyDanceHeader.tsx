import { Link, useNavigate } from 'react-router-dom';
import ExplorerEventSearch from './ExplorerEventSearch';
import HeaderUserMenu from './HeaderUserMenu';
import NotificationBell from './NotificationBell';

export default function MyDanceHeader() {
    const navigate = useNavigate();

    return (
        <header
            className="flex items-center justify-between gap-2 border-b border-line bg-surface px-4"
            style={{ height: 'calc(64px + env(safe-area-inset-top))', paddingTop: 'env(safe-area-inset-top)' }}
        >
            <Link to="/mine" className="flex min-w-0 items-center gap-2.5">
                <img src="/movida.png" alt="" className="h-8 w-8 shrink-0 object-contain" />
                <span className="truncate text-xl font-bold text-ink">MyDance</span>
            </Link>
            <div className="flex shrink-0 items-center gap-1.5">
                <ExplorerEventSearch
                    compact
                    pastToggle
                    onSelectEvent={(eventId) => navigate(`/event/${eventId}`)}
                    triggerLabel="Search events"
                />
                <NotificationBell />
                <HeaderUserMenu avatarOnly />
            </div>
        </header>
    );
}
