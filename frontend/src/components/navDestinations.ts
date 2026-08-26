import { useFeatureFlags } from '../context/FeatureFlagsContext';

export interface NavDestination {
    id: 'explore' | 'for-you' | 'tribe' | 'my-events' | 'mine';
    label: string;
    path: string;
    icon: string;
    isActive: (pathname: string) => boolean;
}

// Order defines the left-to-right / bottom-nav order of the primary surfaces.
const ALL_NAV_DESTINATIONS: NavDestination[] = [
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
        id: 'my-events',
        label: 'My Events',
        path: '/mine/calendar',
        icon: '/calendar.png',
        isActive: (p) => p === '/mine/calendar' || p.startsWith('/mine/calendar/'),
    },
    {
        id: 'mine',
        label: 'MyDance',
        path: '/mine',
        icon: '/dance.png',
        isActive: (p) => p === '/mine' || p.startsWith('/mine/'),
    },
];

/**
 * Hook that returns navigation destinations filtered by feature flags.
 * "My Events" entry is only included if myEventsNavEnabled flag is true.
 */
export function useNavDestinations(): NavDestination[] {
    const { myEventsNavEnabled } = useFeatureFlags();

    return ALL_NAV_DESTINATIONS.filter(
        (dest) => dest.id !== 'my-events' || myEventsNavEnabled
    );
}

/**
 * @deprecated Use useNavDestinations() hook instead for feature-flag-filtered destinations.
 * Kept for backward compatibility; includes all destinations regardless of flags.
 */
export const NAV_DESTINATIONS: NavDestination[] = ALL_NAV_DESTINATIONS;
