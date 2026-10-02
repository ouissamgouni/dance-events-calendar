import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { fetchEvents, fetchInterestProfiles, fetchSettings, fetchTagGroups, type InterestProfile, type PreferredAreaPayload } from '../api';
import { AREA_PRESETS, DEFAULT_AREA_BBOX } from '../constants/area';
import Home from './Home';
import { AuthProvider } from '../context/AuthContext';
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext';
import { AttendanceSummariesProvider } from '../context/AttendanceSummariesContext';
import { SavedEventsProvider } from '../context/SavedEventsContext';
import { PreferencesProvider } from '../context/PreferencesContext';
import { readBrowseSession } from '../utils/browseSession';

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

function LocationProbe() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
        <>
            <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>
            <button type="button" onClick={() => navigate(-1)}>Back</button>
        </>
    );
}

// Mock EventMap to capture initialArea prop
vi.mock('../components/EventMap', () => ({
    default: ({ initialArea }: { initialArea?: PreferredAreaPayload | null }) => (
        <div data-testid="event-map" data-initial-area={JSON.stringify(initialArea)} />
    ),
}));

// Mock all the other components to avoid rendering the full page
vi.mock('../components/EventListPanel', () => ({
    default: ({ onExtendPeriod, nextPeriodEventCount }: { onExtendPeriod?: () => void; nextPeriodEventCount?: number }) => (
        nextPeriodEventCount ? <button type="button" onClick={onExtendPeriod}>Search next dates</button> : <div />
    ),
}));
vi.mock('../components/FilterSheet', () => ({ default: () => <div /> }));
vi.mock('../components/SummaryBar', () => ({
    default: ({ onClearArea }: { onClearArea?: () => void }) => (
        <button type="button" onClick={onClearArea}>Clear area</button>
    ),
}));
vi.mock('../pages/Calendar', () => ({ default: () => <div /> }));
vi.mock('../components/EventDetail', () => ({ default: () => <div /> }));
vi.mock('../components/suggest/SuggestEventWizard', () => ({ default: () => <div /> }));

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

    it('opens Calendar from map view and restores map view through browser history', async () => {
        const user = userEvent.setup();
        render(
            <TestProviders initialEntries={['/?view=map']}>
                <Home />
                <LocationProbe />
            </TestProviders>,
        );

        await user.click(screen.getByRole('button', { name: 'Calendar view' }));

        await waitFor(() => {
            const location = screen.getByTestId('location-probe').textContent ?? '';
            expect(location.startsWith('/calendar')).toBe(true);
            expect(new URLSearchParams(location.split('?')[1]).has('view')).toBe(false);
        });

        await user.click(screen.getByRole('button', { name: 'Back' }));

        await waitFor(() => {
            const location = screen.getByTestId('location-probe').textContent ?? '';
            expect(new URLSearchParams(location.split('?')[1]).get('view')).toBe('map');
            expect(screen.queryByTestId('view-switcher-map')).not.toBeInTheDocument();
            expect(screen.getByTestId('view-switcher-list')).toBeInTheDocument();
        });
    });

    it('opens the map without leaving Browse', async () => {
        const user = userEvent.setup();
        render(
            <TestProviders initialEntries={['/browse']}>
                <Home />
                <LocationProbe />
            </TestProviders>,
        );

        await user.click(screen.getByRole('button', { name: 'Map view' }));

        await waitFor(() => {
            const currentLocation = screen.getByTestId('location-probe').textContent ?? '';
            expect(currentLocation.startsWith('/browse?')).toBe(true);
            expect(new URLSearchParams(currentLocation.split('?')[1]).get('view')).toBe('map');
            expect(screen.queryByTestId('view-switcher-map')).not.toBeInTheDocument();
            expect(screen.getByTestId('view-switcher-list')).toBeInTheDocument();
        });
    });

    it('returns to Browse when switching from Calendar back to List', async () => {
        const user = userEvent.setup();
        render(
            <TestProviders initialEntries={['/browse']}>
                <Home />
                <LocationProbe />
            </TestProviders>,
        );

        // Click Calendar to navigate to /calendar
        await user.click(screen.getByRole('button', { name: 'Calendar view' }));

        await waitFor(() => {
            const location = screen.getByTestId('location-probe').textContent ?? '';
            expect(location.startsWith('/calendar')).toBe(true);
        });

        // Click List to return to /browse
        await user.click(screen.getByRole('button', { name: 'List view' }));

        await waitFor(() => {
            const location = screen.getByTestId('location-probe').textContent ?? '';
            expect(location.startsWith('/browse')).toBe(true);
            expect(screen.getByTestId('view-switcher-map')).toBeInTheDocument();
            expect(screen.getByTestId('view-switcher-calendar')).toBeInTheDocument();
        });
    });

    it('returns to Browse when switching from Calendar to Map', async () => {
        const user = userEvent.setup();
        render(
            <TestProviders initialEntries={['/browse']}>
                <Home />
                <LocationProbe />
            </TestProviders>,
        );

        // Click Calendar to navigate to /calendar
        await user.click(screen.getByRole('button', { name: 'Calendar view' }));

        await waitFor(() => {
            const location = screen.getByTestId('location-probe').textContent ?? '';
            expect(location.startsWith('/calendar')).toBe(true);
        });

        // Click Map to return to /browse with map view
        await user.click(screen.getByRole('button', { name: 'Map view' }));

        await waitFor(() => {
            const location = screen.getByTestId('location-probe').textContent ?? '';
            expect(location.startsWith('/browse?')).toBe(true);
            expect(new URLSearchParams(location.split('?')[1]).get('view')).toBe('map');
        });
    });

    it('scrolls back to top when a filter changes on Browse', async () => {
        const user = userEvent.setup();
        const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => { });
        render(
            <TestProviders initialEntries={['/browse']}>
                <Home />
            </TestProviders>,
        );

        const [clearArea] = await screen.findAllByRole('button', { name: 'Clear area' });
        scrollSpy.mockClear();
        await user.click(clearArea);

        await waitFor(() => {
            expect(scrollSpy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
        });
        scrollSpy.mockRestore();
    });

    it('keeps scroll position when extending the period from the list', async () => {
        const user = userEvent.setup();
        vi.mocked(fetchEvents).mockResolvedValue([
            { event_id: 'e1', title: 'Later social', latitude: null, longitude: null, tags: [] } as unknown as Awaited<ReturnType<typeof fetchEvents>>[number],
        ]);
        const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => { });
        render(
            <TestProviders initialEntries={['/browse']}>
                <Home />
            </TestProviders>,
        );

        const [clearArea] = await screen.findAllByRole('button', { name: 'Clear area' });
        await user.click(clearArea);
        const [extend] = await screen.findAllByRole('button', { name: 'Search next dates' });
        scrollSpy.mockClear();
        const callsBefore = vi.mocked(fetchEvents).mock.calls.length;
        await user.click(extend);

        await waitFor(() => {
            expect(vi.mocked(fetchEvents).mock.calls.length).toBeGreaterThan(callsBefore);
        });
        expect(scrollSpy).not.toHaveBeenCalled();
        scrollSpy.mockRestore();
    });

    it('saves Browse filters and the area override for the session', async () => {
        const user = userEvent.setup();
        render(
            <TestProviders initialEntries={['/browse?tag_ids=3&view=map']}>
                <Home />
            </TestProviders>,
        );

        const [clearArea] = await screen.findAllByRole('button', { name: 'Clear area' });
        await user.click(clearArea);

        await waitFor(() => {
            const saved = readBrowseSession();
            expect(saved?.params.get('tag_ids')).toBe('3');
            expect(saved?.params.has('view')).toBe(false);
            expect(saved?.area).toEqual({ kind: 'show-all' });
        });
    });

    it('does not save filters outside Browse', async () => {
        render(
            <TestProviders initialEntries={['/calendar?tag_ids=3']}>
                <Home />
            </TestProviders>,
        );
        await screen.findAllByRole('button', { name: 'Clear area' });
        expect(readBrowseSession()).toBeNull();
    });
});
