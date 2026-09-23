import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';

export interface NavDestination {
    id: 'explore' | 'browse' | 'my-events' | 'tribe' | 'passport';
    label: string;
    path: string;
    icon: string;
    isActive: (pathname: string) => boolean;
}

// Order defines the left-to-right / bottom-nav order of the primary surfaces.
const EXPLORE_DESTINATION: NavDestination = {
    id: 'explore',
    label: 'Explore',
    path: '/',
    icon: '/find-event.png',
    isActive: (p) => p === '/' || p.startsWith('/search') || p === '/explore',
};

const BROWSE_DESTINATION: NavDestination = {
    id: 'browse',
    label: 'Browse',
    path: '/browse',
    icon: '/filter.png',
    isActive: (p) => p.startsWith('/browse') || p === '/calendar',
};

export const NAV_DESTINATIONS: NavDestination[] = [
    EXPLORE_DESTINATION,
    {
        id: 'my-events',
        label: 'My Events',
        path: '/my-events',
        icon: '/calendar.png',
        isActive: (p) => p === '/my-events' || p.startsWith('/my-events/'),
    },
    {
        id: 'tribe',
        label: 'Tribe',
        path: '/tribe',
        icon: '/people-2.png',
        isActive: (p) => p === '/tribe' || p.startsWith('/tribe/'),
    },
    {
        id: 'passport',
        label: 'Passport',
        path: '/passport',
        icon: '/passport.png',
        isActive: (p) => p === '/passport' || p.startsWith('/passport/'),
    },
];

/**
 * Shared mobile and desktop destinations.
 */
export function useNavDestinations(): NavDestination[] {
    const { browseNavEnabled } = useOptionalFeatureFlags();
    if (browseNavEnabled) {
        return [EXPLORE_DESTINATION, BROWSE_DESTINATION, ...NAV_DESTINATIONS.slice(1)];
    }
    return NAV_DESTINATIONS.map((destination) => destination.id === 'explore'
        ? { ...destination, isActive: (pathname) => destination.isActive(pathname) || BROWSE_DESTINATION.isActive(pathname) }
        : destination);
}
