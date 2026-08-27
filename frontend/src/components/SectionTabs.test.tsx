import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import SectionLayout from './SectionTabs';

vi.mock('./MyEventsUtilityMenu', () => ({
    default: () => <button type="button">Share and export My Events</button>,
}));

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

    it('renders the approved My Events title and share action', () => {
        renderMineRoute('/mine/calendar');

        expect(screen.getByRole('heading', { name: 'My Events' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'MyDance' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Share and export My Events' })).toBeInTheDocument();
    });
});
