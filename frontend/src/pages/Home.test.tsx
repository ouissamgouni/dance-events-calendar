import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PreferredAreaPayload } from '../api';
import { AREA_PRESETS, DEFAULT_AREA_BBOX } from '../constants/area';
import Home from './Home';

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
    });

    it('uses latest flyToAreaBbox as initialArea when map mounts after area is applied', async () => {
        // This test verifies the fix for: when a user applies an area filter in
        // list view, then switches to map mode on mobile, the map should mount
        // with the newly applied area bbox, not the old startup bbox.

        const europe = AREA_PRESETS.find((p) => p.label === 'Europe')!;

        // Simulate: navigate to explorer (default startup area), then apply Europe.
        // The FlyToAreaController will set flyToAreaBbox to europe, with an
        // incremented token. When the map mounts (mobile fullscreen), EventMap
        // should receive initialArea = europe, not DEFAULT_AREA_BBOX.

        const { rerender } = render(
            <MemoryRouter initialEntries={['/']}>
                <Home />
            </MemoryRouter>,
        );

        // Initially, EventMap should receive the startup DEFAULT_AREA_BBOX
        await waitFor(() => {
            const map = screen.getByTestId('event-map');
            const initialArea = JSON.parse(map.getAttribute('data-initial-area') || 'null');
            expect(initialArea).toEqual(DEFAULT_AREA_BBOX);
        });

        // Now simulate applying Europe area by changing URL to include area in params
        // (the handleApplyAreaFromSheet flow sets flyToAreaBbox in state and bumps
        // the token). When the map re-renders, it should now receive europe as
        // initialArea instead of the stale DEFAULT_AREA_BBOX.
        rerender(
            <MemoryRouter initialEntries={['/?area_label=Europe']}>
                <Home />
            </MemoryRouter>,
        );

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
            <MemoryRouter initialEntries={['/']}>
                <Home />
            </MemoryRouter>,
        );

        await waitFor(() => {
            const map = screen.getByTestId('event-map');
            const initialArea = JSON.parse(map.getAttribute('data-initial-area') || 'null');
            expect(initialArea).toEqual(DEFAULT_AREA_BBOX);
        });
    });
});
