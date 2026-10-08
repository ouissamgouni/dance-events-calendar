import { Link, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export interface SectionTab {
    label: string;
    path: string;
}

export const TRIBE_TABS: SectionTab[] = [
    { label: 'Calendars', path: '/tribe/calendars' },
    { label: 'Activity', path: '/tribe/activity' },
    { label: 'People', path: '/tribe/network' },
    { label: 'Reviews', path: '/tribe/reviews' },
];

export const MINE_TABS: SectionTab[] = [
    { label: 'Overview', path: '/mine' },
    { label: 'My Events', path: '/mine/calendar' },
    { label: 'Passport', path: '/mine/passport' },
    { label: 'Profiles', path: '/mine/profiles' },
    { label: 'Reviews', path: '/mine/reviews' },
];

const SECTION_CONFIG = {
    tribe: { hub: '/tribe', tabs: TRIBE_TABS },
    mine: { hub: '/mine', tabs: MINE_TABS },
} as const;

export type SectionKey = keyof typeof SECTION_CONFIG;

const SECTION_GATE: Record<SectionKey, { title: string; body: string }> = {
    tribe: {
        title: 'My Tribe',
        body: 'Sign in to connect with friends, discover people you may know, and follow their calendars.',
    },
    mine: {
        title: 'Your dance world',
        body: 'Sign in to track events, unlock passport milestones, and manage your saved and going lists.',
    },
};

function getTitleForMinePath(pathname: string): string | null {
    // Map /mine sub-paths to their display titles
    if (pathname === '/mine/calendar') return 'My Events';
    if (pathname === '/mine/passport') return 'Passport';
    if (pathname === '/mine/profiles' || pathname.startsWith('/mine/profiles/')) return 'Profiles';
    if (pathname === '/mine/reviews') return 'Reviews';
    return null;
}

function SectionTabs({ tabs, pathname, hub }: { tabs: SectionTab[]; pathname: string; hub: string }) {
    return (
        <nav
            aria-label="Section"
            className="grid grid-flow-col auto-cols-fr overflow-x-auto md:flex md:gap-1 md:px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
            {tabs.map((t) => {
                // The hub tab (e.g. /mine) matches its own path exactly so it
                // doesn't stay active on deeper sub-routes like /mine/calendar.
                const active = t.path === hub
                    ? pathname === hub
                    : pathname === t.path || pathname.startsWith(t.path + '/');
                return (
                    <Link
                        key={t.path}
                        to={t.path}
                        aria-current={active ? 'page' : undefined}
                        className={`relative shrink-0 py-4 text-center text-sm font-medium transition md:px-3 ${active
                            ? 'text-action'
                            : 'text-ink hover:text-action'
                            }`}
                    >
                        {t.label}
                        {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-action" />}
                    </Link>
                );
            })}
        </nav>
    );
}

/**
 * Layout wrapper for /tribe/* and /mine/* pages: renders a tab bar, then the
 * routed sub-page via <Outlet />.
 */
export default function SectionLayout({ section }: { section: SectionKey }) {
    const { pathname } = useLocation();
    const { user, loading } = useAuth();
    const { hub, tabs } = SECTION_CONFIG[section];
    const title = section === 'tribe' ? 'My Tribe' : null;
    const minePageTitle = section === 'mine' ? getTitleForMinePath(pathname) : null;
    const isMyEvents = pathname === '/mine/calendar';
    // Tribe > Calendars renders the wide explorer; the header must share its left edge.
    const headerWidth = pathname === '/tribe/calendars' ? 'max-w-7xl' : 'max-w-3xl';

    // Whole-section login gate (soft in-page callout). Every /tribe/* and
    // /mine/* route is signed-in only.
    if (!loading && !user) {
        const gate = SECTION_GATE[section];
        return (
            <div className="min-h-full bg-[#f8fafc]">
                <div className="mx-auto max-w-3xl px-4 py-4">
                    <div className="border border-blue-100 bg-blue-50 p-4 text-sm text-ink">
                        <p className="mb-2 font-medium text-ink">{gate.title}</p>
                        <p className="mb-3 text-ink-soft">{gate.body}</p>
                        <Link
                            to={`/login?next=${encodeURIComponent(pathname)}`}
                            className="inline-flex items-center bg-action px-3 py-1.5 text-xs font-semibold text-white hover:bg-action focus:outline-none focus:ring-2 focus:ring-blue-300"
                        >
                            Sign in
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={isMyEvents ? 'flex h-full min-h-0 flex-col overflow-hidden bg-canvas' : 'min-h-full bg-[#f8fafc]'}>
            {section !== 'mine' && (
                <div className="border-b border-line bg-surface">
                    <div className={`mx-auto ${headerWidth}`}>
                        {title && <h1 className="px-4 py-3 text-2xl font-bold text-ink">{title}</h1>}
                        <SectionTabs tabs={tabs} pathname={pathname} hub={hub} />
                    </div>
                </div>
            )}
            {section === 'mine' && pathname !== hub && minePageTitle && !isMyEvents && (
                <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
                    {pathname === '/mine/calendar' ? (
                        <h1 className="text-2xl font-bold text-ink">My Events</h1>
                    ) : (
                        <div className="flex items-center gap-2 text-xl font-semibold text-ink">
                            <Link
                                to="/mine"
                                className="text-action hover:text-action focus:outline-none"
                            >
                                MyDance
                            </Link>
                            <span className="text-ink-soft">&gt;</span>
                            <span>{minePageTitle}</span>
                        </div>
                    )}
                </div>
            )}
            <Outlet />
        </div>
    );
}
