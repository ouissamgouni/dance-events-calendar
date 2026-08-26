import { Link, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import MyEventsUtilityMenu from './MyEventsUtilityMenu';

export interface SectionTab {
    label: string;
    path: string;
}

export const TRIBE_TABS: SectionTab[] = [
    { label: 'Calendars', path: '/tribe/calendars' },
    { label: 'Activity', path: '/tribe/activity' },
    { label: 'Discover', path: '/tribe/discover' },
    { label: 'Network', path: '/tribe/network' },
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
        title: 'Your Tribe',
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
            className="flex items-center gap-1 overflow-x-auto border-b border-line px-4 scrollbar-none"
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
                        className={`shrink-0 -mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition ${active
                            ? 'border-action text-action'
                            : 'border-transparent text-ink-soft hover:text-ink'
                            }`}
                    >
                        {t.label}
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
    const title = section === 'tribe' ? 'Your Tribe' : null;
    const minePageTitle = section === 'mine' ? getTitleForMinePath(pathname) : null;

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
        <div className="min-h-full bg-[#f8fafc]">
            {section !== 'mine' && (
                <div className="border-b border-line bg-surface px-4 pt-1">
                    {title && <h1 className="px-1 pb-1 pt-1 text-xl font-semibold text-ink">{title}</h1>}
                    <SectionTabs tabs={tabs} pathname={pathname} hub={hub} />
                </div>
            )}
            {section === 'mine' && pathname !== hub && minePageTitle && (
                <div className="flex items-center justify-between gap-3 px-4 py-3">
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
                    {pathname === '/mine/calendar' && <MyEventsUtilityMenu />}
                </div>
            )}
            <Outlet />
        </div>
    );
}
