export interface NavDestination {
    id: 'explore' | 'for-you' | 'tribe' | 'mine';
    label: string;
    path: string;
    icon: string;
    isActive: (pathname: string) => boolean;
}

// Order defines the left-to-right / bottom-nav order of the four primary surfaces.
export const NAV_DESTINATIONS: NavDestination[] = [
    {
        id: 'explore',
        label: 'Explore',
        path: '/',
        icon: '/find-event.png',
        isActive: (p) => p === '/' || p === '/calendar',
    },
    {
        id: 'for-you',
        label: 'For You',
        path: '/for-you',
        icon: '/sparkles.png',
        isActive: (p) => p === '/for-you',
    },
    {
        id: 'tribe',
        label: 'Tribe',
        path: '/tribe',
        icon: '/people-2.png',
        isActive: (p) => p === '/tribe' || p.startsWith('/tribe/'),
    },
    {
        id: 'mine',
        label: 'Mine',
        path: '/mine',
        icon: '/calendar.png',
        isActive: (p) => p === '/mine' || p.startsWith('/mine/'),
    },
];
