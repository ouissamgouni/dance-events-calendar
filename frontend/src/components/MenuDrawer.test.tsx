import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import MenuDrawer from './MenuDrawer';

vi.mock('../context/AuthContext', () => ({
    useAuth: () => ({ user: { name: 'Ouissam Gouni', handle: 'ouissam', avatar_url: null, is_admin: true }, logout: vi.fn() }),
}));

describe('MenuDrawer', () => {
    it('shows account utilities', () => {
        render(<MemoryRouter><MenuDrawer open onClose={vi.fn()} /></MemoryRouter>);

        expect(screen.getByRole('link', { name: 'Saved searches' })).toHaveAttribute('href', '/saved-searches');
        expect(screen.getByRole('link', { name: /Reviews/ })).toHaveAttribute('href', '/reviews');
        const notificationsLink = screen.getByRole('link', { name: 'Notifications' });
        expect(notificationsLink).toHaveAttribute('href', '/notifications');
        expect(notificationsLink.querySelector('img')).toHaveAttribute('src', '/notification.png');
        expect(screen.getByRole('link', { name: 'Help & support' })).toHaveAttribute('href', expect.stringContaining('mailto:support@joinmovida.com'));
        expect(screen.queryByRole('link', { name: /Dance Passport/ })).not.toBeInTheDocument();
    });

    it('uses the calendar icon for the Explore entry on admin pages', () => {
        render(<MemoryRouter initialEntries={['/admin']}><MenuDrawer open onClose={vi.fn()} /></MemoryRouter>);

        const exploreLink = screen.getByRole('link', { name: 'Explore' });
        expect(exploreLink).toHaveAttribute('href', '/');
        expect(exploreLink.querySelector('img')).toHaveAttribute('src', '/calendar.png');
    });
});
