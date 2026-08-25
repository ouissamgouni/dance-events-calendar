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

    it('retains secondary tabs on Mine subroutes', () => {
        renderMineRoute('/mine/passport');

        expect(screen.getByText('Passport content')).toBeInTheDocument();
        expect(screen.getByRole('navigation', { name: 'Section' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Passport' })).toHaveAttribute('aria-current', 'page');
    });
});
