import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fetchEvents, fetchInterestProfiles, fetchSettings, fetchTagGroups, type InterestProfile, type PreferredAreaPayload } from '../api';
import { AREA_PRESETS, DEFAULT_AREA_BBOX } from '../constants/area';
import Home from './Home';
import { AuthProvider } from '../context/AuthContext';
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext';
import { AttendanceSummariesProvider } from '../context/AttendanceSummariesContext';
import { SavedEventsProvider } from '../context/SavedEventsContext';
import { PreferencesProvider } from '../context/PreferencesContext';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return {
        ...actual,
        fetchEvents: vi.fn().mockResolvedValue([]),
        fetchSettings: vi.fn().mockResolvedValue({}),
        fetchTagGroups: vi.fn().mockResolvedValue([]),
        fetchInterestProfiles: vi.fn().mockResolvedValue([]),
    };
});

vi.mock('../context/AuthContext', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../context/AuthContext')>();
    return {
        ...actual,
        useAuth: () => ({
            user: { user_id: 'test-user', email: 'test@example.com' },
            loading: false,
        }),
    };
});

function TestProviders({ children, initialEntries }: { children: React.ReactNode; initialEntries: string[] }) {
    return (
        <MemoryRouter initialEntries={initialEntries}>
            <AuthProvider>
                <FeatureFlagsProvider>
                    <AttendanceSummariesProvider>
                        <SavedEventsProvider>
                            <PreferencesProvider>{children}</PreferencesProvider>
                        </SavedEventsProvider>
                    </AttendanceSummariesProvider>
                </FeatureFlagsProvider>
            </AuthProvider>
        </MemoryRouter>
    );
}

// Mock EventMap to capture initialArea prop
vi.mock('../components/EventMap', () => ({
    default: ({ initialArea }: { initialArea?: PreferredAreaPayload | null }) => (
        <div data-testid="event-map" data-initial-area={JSON.stringify(initialArea)} />
    ),
}));

// Mock all the other components to avoid rendering the full page
vi.mock('../components/EventListPanel', () => ({ default: () => <div /> }));
vi.mock('../components/FilterSheet', () => ({ default: () => <div /> }));
vi.mock('../components/SummaryBar', () => ({ default: () => <div /> }));
vi.mock('../pages/Calendar', () => ({ default: () => <div /> }));
vi.mock('../components/EventDetail', () => ({ default: () => <div /> }));
vi.mock('../components/SuggestEventModal', () => ({ default: () => <div /> }));

describe('Home — mobile map mount with applied area', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fetchEvents).mockResolvedValue([]);
        vi.mocked(fetchSettings).mockResolvedValue({} as Awaited<ReturnType<typeof fetchSettings>>);
        vi.mocked(fetchTagGroups).mockResolvedValue([]);
        vi.mocked(fetchInterestProfiles).mockResolvedValue([]);
        window.matchMedia = vi.fn().mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
    });

    it('uses the latest hydrated profile area instead of the startup area', async () => {
        // This test verifies the fix for: when a user applies an area filter in
        // list view, then switches to map mode on mobile, the map should mount
        // with the newly applied area bbox, not the old startup bbox.

        const europe = AREA_PRESETS.find((p) => p.label === 'Europe')!;
        let resolveProfiles!: (profiles: InterestProfile[]) => void;
        vi.mocked(fetchInterestProfiles).mockReturnValue(new Promise((resolve) => {
            resolveProfiles = resolve;
        }));

        // Simulate: navigate to explorer (default startup area), then apply Europe.
        // The FlyToAreaController will set flyToAreaBbox to europe, with an
        // incremented token. When the map mounts (mobile fullscreen), EventMap
        // should receive initialArea = europe, not DEFAULT_AREA_BBOX.

        render(
            <TestProviders initialEntries={['/']}>
                <Home />
            </TestProviders>,
        );

        // Initially, EventMap should receive the startup DEFAULT_AREA_BBOX
        await waitFor(() => {
            const map = screen.getByTestId('event-map');
            const initialArea = JSON.parse(map.getAttribute('data-initial-area') || 'null');
            expect(initialArea).toEqual(DEFAULT_AREA_BBOX);
        });

        resolveProfiles([{
            id: 1,
            label: 'Europe profile',
            area_label: europe.label,
            geo_kind: 'area',
            min_lat: europe.min_lat,
            min_lng: europe.min_lng,
            max_lat: europe.max_lat,
            max_lng: europe.max_lng,
            center_lat: null,
            center_lng: null,
            radius_km: null,
            dance_tag_ids: [],
            reach_filter: 'any',
            reach_tag_ids: [],
            matches_enabled: false,
            notify_enabled: false,
            is_active: true,
            created_at: '2024-01-01T00:00:00Z',
        }]);

        // After area is applied, EventMap should receive the applied area
        await waitFor(() => {
            const map = screen.getByTestId('event-map');
            const initialArea = JSON.parse(map.getAttribute('data-initial-area') || 'null');
            // The map should use the latest applied area (Europe) instead of the
            // startup area, when the map mounts on mobile after the area was applied.
            expect(initialArea).toMatchObject({
                min_lat: europe.min_lat,
                min_lng: europe.min_lng,
                max_lat: europe.max_lat,
                max_lng: europe.max_lng,
            });
        });
    });

    it('uses initialAreaRef when no flyToAreaBbox is pending', async () => {
        // Fallback: when no area has been applied (no pending flyToAreaBbox),
        // the map should use the startup initialAreaRef as before.

        render(
            <TestProviders initialEntries={['/']}>
                <Home />
            </TestProviders>,
        );

        await waitFor(() => {
            const map = screen.getByTestId('event-map');
            const initialArea = JSON.parse(map.getAttribute('data-initial-area') || 'null');
            expect(initialArea).toEqual(DEFAULT_AREA_BBOX);
        });
    });
});
