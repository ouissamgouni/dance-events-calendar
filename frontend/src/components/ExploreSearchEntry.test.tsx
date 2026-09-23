import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext';
import ExploreSearchEntry from './ExploreSearchEntry';

function SearchDestination() {
    const location = useLocation();
    return <p>{`Return to: ${String((location.state as { returnTo?: string } | null)?.returnTo)}`}</p>;
}

function CurrentLocation() {
    const location = useLocation();
    return <p>{`${location.pathname}${location.search}`}</p>;
}

describe('ExploreSearchEntry', () => {
    it('expands and collapses the progressive search actions', async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><ExploreSearchEntry /></MemoryRouter>);

        await user.click(screen.getByRole('button', { name: 'Start your search' }));
        expect(screen.getByRole('button', { name: /Search events, places, or tags/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Browse events' })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Collapse search' }));
        expect(screen.getByRole('button', { name: 'Start your search' })).toBeInTheDocument();
    });

    it('opens text search with Explore as the return destination', async () => {
        const user = userEvent.setup();
        render(
            <MemoryRouter>
                <Routes>
                    <Route path="/" element={<ExploreSearchEntry />} />
                    <Route path="/search" element={<SearchDestination />} />
                </Routes>
            </MemoryRouter>,
        );

        await user.click(screen.getByRole('button', { name: 'Start your search' }));
        await user.click(screen.getByRole('button', { name: /Search events, places, or tags/ }));
        expect(await screen.findByText('Return to: /')).toBeInTheDocument();
    });

    it('opens Browse with the filter sheet when direct Explorer is disabled', async () => {
        const user = userEvent.setup();
        render(
            <MemoryRouter>
                <Routes>
                    <Route path="/" element={<ExploreSearchEntry />} />
                    <Route path="/browse" element={<CurrentLocation />} />
                </Routes>
            </MemoryRouter>,
        );

        await user.click(screen.getByRole('button', { name: 'Start your search' }));
        await user.click(screen.getByRole('button', { name: 'Browse events' }));
        expect(await screen.findByText('/browse?sheet=1')).toBeInTheDocument();
    });

    it('opens Browse directly when the direct Explorer flag is enabled', async () => {
        const user = userEvent.setup();
        render(
            <FeatureFlagsContext.Provider value={{
                flags: { ...defaultFlags, browseDirectToExplorerEnabled: true },
                updateFlag: vi.fn(),
            }}>
                <MemoryRouter>
                    <Routes>
                        <Route path="/" element={<ExploreSearchEntry />} />
                        <Route path="/browse" element={<CurrentLocation />} />
                    </Routes>
                </MemoryRouter>
            </FeatureFlagsContext.Provider>,
        );

        await user.click(screen.getByRole('button', { name: 'Start your search' }));
        await user.click(screen.getByRole('button', { name: 'Browse events' }));
        expect(await screen.findByText('/browse')).toBeInTheDocument();
    });

    it('collapses expanded actions when the search entry becomes sticky', async () => {
        const user = userEvent.setup();
        const { rerender } = render(
            <MemoryRouter><ExploreSearchEntry /></MemoryRouter>,
        );

        await user.click(screen.getByRole('button', { name: 'Start your search' }));
        rerender(<MemoryRouter><ExploreSearchEntry isSticky /></MemoryRouter>);

        expect(await screen.findByRole('button', { name: 'Start your search' })).toBeInTheDocument();
        expect(screen.queryByTestId('explore-search-expanded')).not.toBeInTheDocument();
    });
});
