import { Link, useLocation, Outlet } from 'react-router-dom';

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

function SectionTabs({ tabs, pathname, hub }: { tabs: SectionTab[]; pathname: string; hub: string }) {
    return (
        <nav
            aria-label="Section"
            className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 px-4 scrollbar-none"
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
                            ? 'border-blue-500 text-blue-600'
                            : 'border-transparent text-slate-500 hover:text-slate-700'
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
    const { hub, tabs } = SECTION_CONFIG[section];
    return (
        <div className="min-h-full bg-[#f8fafc]">
            <div className="border-b border-slate-200 bg-white px-4 pt-1">
                <SectionTabs tabs={tabs} pathname={pathname} hub={hub} />
            </div>
            <Outlet />
        </div>
    );
}
