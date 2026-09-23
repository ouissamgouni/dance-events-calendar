import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { fetchMyPendingReviews } from '../api';
import MenuDrawer from './MenuDrawer';

vi.mock('../api', () => ({ fetchMyPendingReviews: vi.fn() }));
vi.mock('../context/AuthContext', () => ({
    useAuth: () => ({ user: { name: 'Ouissam Gouni', handle: 'ouissam', avatar_url: null, is_admin: true }, logout: vi.fn() }),
}));

describe('MenuDrawer', () => {
    it('shows account utilities and the pending review badge', async () => {
        vi.mocked(fetchMyPendingReviews).mockResolvedValue([
            { event_id: 'one', event_title: 'One', event_start: null, event_end: null, friend_proof: null },
            { event_id: 'two', event_title: 'Two', event_start: null, event_end: null, friend_proof: null },
        ]);
        render(<MemoryRouter><MenuDrawer open onClose={vi.fn()} /></MemoryRouter>);

        expect(await screen.findByText('2')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Saved searches' })).toHaveAttribute('href', '/saved-searches');
        expect(screen.getByRole('link', { name: /Reviews/ })).toHaveAttribute('href', '/reviews');
        const notificationsLink = screen.getByRole('link', { name: 'Notifications' });
        expect(notificationsLink).toHaveAttribute('href', '/notifications');
        expect(notificationsLink.querySelector('img')).toHaveAttribute('src', '/notification.png');
        expect(screen.getByRole('link', { name: 'Help & support' })).toHaveAttribute('href', expect.stringContaining('mailto:support@joinmovida.com'));
        expect(screen.queryByRole('link', { name: /Dance Passport/ })).not.toBeInTheDocument();
    });

    it('uses the calendar icon for the Explore entry on admin pages', () => {
        vi.mocked(fetchMyPendingReviews).mockResolvedValue([]);
        render(<MemoryRouter initialEntries={['/admin']}><MenuDrawer open onClose={vi.fn()} /></MemoryRouter>);

        const exploreLink = screen.getByRole('link', { name: 'Explore' });
        expect(exploreLink).toHaveAttribute('href', '/');
        expect(exploreLink.querySelector('img')).toHaveAttribute('src', '/calendar.png');
    });
});
