import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEventsByIds, searchEventsPage } from '../api';
import TextSearchPage from './TextSearchPage';
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext';

vi.mock('../api', () => ({ fetchEventsByIds: vi.fn(), searchEventsPage: vi.fn() }));
vi.mock('../components/CardActionCluster', () => ({ default: () => <span data-testid="card-actions" /> }));
vi.mock('../components/AttendeeAvatarStack', () => ({ default: () => <span data-testid="card-avatars" /> }));
vi.mock('../components/CardReviewsLine', () => ({ default: () => <span data-testid="card-reviews" /> }));

function LocationProbe() {
    const location = useLocation();
    return <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>;
}

describe('TextSearchPage', () => {
    afterEach(() => vi.clearAllMocks());

    it('shows a limited query preview and routes to query-only full results', async () => {
        vi.mocked(searchEventsPage).mockResolvedValue({
            results: [{ event_id: 'prague-1', title: 'Prague Salsa Marathon', start: '2026-09-24T18:00:00Z', location: 'Palace Hall', city: 'Prague', country: 'Czechia', matched_fields: ['title'], matched_tags: [] }],
            total: 12,
            hasMore: true,
        });
        vi.mocked(fetchEventsByIds).mockResolvedValue([{
            event_id: 'prague-1', calendar_id: 'calendar-1', title: 'Prague Salsa Marathon', description: null, image_url: '/prague.jpg', location: 'Palace Hall', city: 'Prague', country: 'Czechia', latitude: null, longitude: null, start: '2026-09-24T18:00:00Z', end: '2026-09-25T02:00:00Z', all_day: false, color: null, view_count: 0, price_min: null, price_max: null, price_currency: null, price_is_free: false, links: null, tags: [],
        }]);
        render(
            <MemoryRouter initialEntries={['/search?q=prague']}>
                <FeatureFlagsContext.Provider value={{ flags: defaultFlags, updateFlag: vi.fn() }}>
                    <Routes>
                        <Route path="/search" element={<TextSearchPage />} />
                    </Routes>
                </FeatureFlagsContext.Provider>
            </MemoryRouter>,
        );

        expect(await screen.findByText('Prague Salsa Marathon')).toBeInTheDocument();
        expect(screen.getByText('12 matching events')).toBeInTheDocument();
        expect(screen.getByTestId('event-card-image')).toHaveAttribute('src', '/prague.jpg');
        expect(screen.getByRole('link', { name: 'Show all 12 matching events' })).toHaveAttribute('href', '/search/results?q=prague');
        expect(screen.getByRole('textbox', { name: 'Search events by name' })).toHaveAttribute('type', 'text');
        expect(screen.getAllByRole('button', { name: 'Clear search' })).toHaveLength(1);
        expect(screen.queryByText(/filter/i)).not.toBeInTheDocument();
    });

    it('uses the rich browser card composition on the full-results route', async () => {
        vi.mocked(searchEventsPage).mockResolvedValue({
            results: [{ event_id: 'prague-1', title: 'Prague Salsa Marathon', start: '2026-09-24T18:00:00Z', location: 'Palace Hall', city: 'Prague', country: 'Czechia', matched_fields: ['title'], matched_tags: [] }],
            total: 1,
            hasMore: false,
        });
        vi.mocked(fetchEventsByIds).mockResolvedValue([{
            event_id: 'prague-1', calendar_id: 'calendar-1', title: 'Prague Salsa Marathon', description: null, image_url: '/prague.jpg', location: 'Palace Hall', city: 'Prague', country: 'Czechia', latitude: null, longitude: null, start: '2026-09-24T18:00:00Z', end: '2026-09-25T02:00:00Z', all_day: false, color: null, view_count: 0, price_min: null, price_max: null, price_currency: null, price_is_free: false, links: null, tags: [],
        }]);
        render(
            <MemoryRouter initialEntries={['/search/results?q=prague']}>
                <FeatureFlagsContext.Provider value={{ flags: defaultFlags, updateFlag: vi.fn() }}>
                    <Routes><Route path="/search/results" element={<TextSearchPage />} /></Routes>
                </FeatureFlagsContext.Provider>
            </MemoryRouter>,
        );

        expect(await screen.findByTestId('text-search-event-card')).toBeInTheDocument();
        expect(screen.getByTestId('event-card-image')).toHaveAttribute('src', '/prague.jpg');
        expect(screen.getAllByTestId('card-actions').length).toBeGreaterThan(0);
        expect(screen.getByTestId('card-avatars')).toBeInTheDocument();
        expect(screen.getByTestId('card-reviews')).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /Show all/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/filter/i)).not.toBeInTheDocument();
    });

    it('returns a changed full-results query to preview mode with a refreshed Show all link', async () => {
        vi.mocked(searchEventsPage).mockImplementation(async (query, limit) => ({
            results: [{ event_id: `${query}-1`, title: `${query} social`, start: '2026-09-24T18:00:00Z', location: 'Dance Hall', city: null, country: null, matched_fields: ['title'], matched_tags: [] }],
            total: query === 'berlin' ? 7 : 12,
            hasMore: (limit ?? 0) < 7,
        }));
        vi.mocked(fetchEventsByIds).mockResolvedValue([]);

        render(
            <MemoryRouter initialEntries={[{ pathname: '/search/results', search: '?q=prague', state: { returnTo: '/' } }]}>
                <FeatureFlagsContext.Provider value={{ flags: defaultFlags, updateFlag: vi.fn() }}>
                    <LocationProbe />
                    <Routes>
                        <Route path="/search" element={<TextSearchPage />} />
                        <Route path="/search/results" element={<TextSearchPage />} />
                    </Routes>
                </FeatureFlagsContext.Provider>
            </MemoryRouter>,
        );

        await screen.findByText('prague social');
        fireEvent.change(screen.getByRole('textbox', { name: 'Search events by name' }), { target: { value: 'berlin' } });

        await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent('/search?q=berlin'));
        expect(await screen.findByRole('link', { name: 'Show all 7 matching events' })).toBeInTheDocument();
        expect(searchEventsPage).toHaveBeenLastCalledWith('berlin', 3);
    });

    it('keeps Show all in full mode and Back returns directly to the entry page', async () => {
        vi.mocked(searchEventsPage).mockResolvedValue({
            results: [{ event_id: 'prague-1', title: 'Prague Salsa Marathon', start: '2026-09-24T18:00:00Z', location: 'Palace Hall', city: 'Prague', country: 'Czechia', matched_fields: ['title'], matched_tags: [] }],
            total: 12,
            hasMore: true,
        });
        vi.mocked(fetchEventsByIds).mockResolvedValue([]);

        render(
            <MemoryRouter initialEntries={[{ pathname: '/search', search: '?q=prague', state: { returnTo: '/calendar?view=map' } }]}>
                <FeatureFlagsContext.Provider value={{ flags: defaultFlags, updateFlag: vi.fn() }}>
                    <LocationProbe />
                    <Routes>
                        <Route path="/search" element={<TextSearchPage />} />
                        <Route path="/search/results" element={<TextSearchPage />} />
                        <Route path="/calendar" element={<p>Calendar origin</p>} />
                    </Routes>
                </FeatureFlagsContext.Provider>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('link', { name: 'Show all 12 matching events' }));
        await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent('/search/results?q=prague'));
        expect(screen.queryByRole('link', { name: /Show all/ })).not.toBeInTheDocument();
        expect(searchEventsPage).toHaveBeenLastCalledWith('prague', 20);

        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(await screen.findByText('Calendar origin')).toBeInTheDocument();
        expect(screen.getByTestId('location-probe')).toHaveTextContent('/calendar?view=map');
    });
});
