import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import SectionLayout from './SectionTabs';

vi.mock('../context/AuthContext', () => ({
    useAuth: () => ({ user: { user_id: 'user-1' }, loading: false }),
}));

function renderMineRoute(path: string) {
    render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route path="/mine" element={<SectionLayout section="mine" />}>
                    <Route index element={<div>Dashboard content</div>} />
                    <Route path="passport" element={<div>Passport content</div>} />
                    <Route path="calendar" element={<div>Calendar content</div>} />
                </Route>
            </Routes>
        </MemoryRouter>,
    );
}

describe('Mine SectionLayout', () => {
    it('does not render secondary tabs on the dashboard overview', () => {
        renderMineRoute('/mine');

        expect(screen.getByText('Dashboard content')).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Section' })).not.toBeInTheDocument();
    });

    it('retains the Mine breadcrumb on non-calendar subroutes', () => {
        renderMineRoute('/mine/passport');

        expect(screen.getByText('Passport content')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'MyDance' })).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Section' })).not.toBeInTheDocument();
    });

    it('delegates the My Events title to the page on the calendar route', () => {
        renderMineRoute('/mine/calendar');

        expect(screen.getByText('Calendar content')).toBeInTheDocument();
        // The "My Events" title now lives in the page itself (merged into its
        // header row), so the layout renders neither its own heading nor the
        // Mine breadcrumb on this route.
        expect(screen.queryByRole('heading', { name: 'My Events' })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'MyDance' })).not.toBeInTheDocument();
    });
});
