import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, FriendMini } from '../types';
import { renderWithProviders } from '../test/render';
import FriendsAreGoingCard from './FriendsAreGoingCard';

const friends: FriendMini[] = [
    { user_id: '1', handle: 'martina', display_name: 'Martina Rossi', avatar_url: '/martina.jpg' },
    { user_id: '2', handle: 'christian', display_name: 'Christian Berg', avatar_url: null },
    { user_id: '3', handle: 'mido', display_name: 'Mido Ali', avatar_url: null },
    { user_id: '4', handle: 'lea', display_name: 'Lea Martin', avatar_url: null },
    { user_id: '5', handle: 'noah', display_name: 'Noah Silva', avatar_url: null },
];

const event: CalendarEvent = {
    event_id: 'evt-social',
    calendar_id: 'cal-1',
    title: 'SALSARAVE 2026',
    description: null,
    image_url: '/event.jpg',
    location: 'Club Bahnhof, Cologne, Germany',
    latitude: null,
    longitude: null,
    start: '2026-10-10T20:00:00',
    end: '2026-10-12T02:00:00',
    all_day: false,
    color: null,
    view_count: 0,
    friends_going_count: 5,
    friends_going_preview: friends,
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: false,
    links: null,
    tags: [],
};

function renderCard(onClick = vi.fn(), cardEvent = event) {
    const user = userEvent.setup();
    renderWithProviders(<FriendsAreGoingCard event={cardEvent} onClick={onClick} />);
    return { user, onClick };
}

describe('FriendsAreGoingCard', () => {
    it('renders a shorter card, caps the displayed names at 3, and keeps the avatar overflow', () => {
        renderCard();

        expect(screen.getByTestId('friends-going-card')).toHaveClass('h-[150px]', 'w-[240px]', 'snap-start', 'rounded-card');
        expect(screen.getByTestId('friends-going-event-image')).toHaveAttribute('src', '/event.jpg');
        expect(within(screen.getByTestId('friends-going-avatars')).getAllByRole('link')).toHaveLength(4);
        expect(screen.getByRole('link', { name: 'See 2 more friends going' })).toHaveTextContent('+2');
        expect(screen.getByAltText('Martina')).toHaveClass('h-[18px]', 'w-[18px]');
        expect(screen.getByText('Martina, Christian, Mido')).toBeInTheDocument();
        expect(screen.getByText('friends are going to')).toBeInTheDocument();
        expect(screen.getByText('Oct 10\u201312 \u00b7 Cologne, Germany')).toBeInTheDocument();
    });

    it('removes a failed image without reserving a placeholder slot', () => {
        renderCard();
        fireEvent.error(screen.getByTestId('friends-going-event-image'));
        expect(screen.queryByTestId('friends-going-event-image')).not.toBeInTheDocument();
        expect(screen.getByText('Martina, Christian, Mido').parentElement).not.toHaveClass('pr-20');
    });

    it('keeps profile and attendees actions from opening the event', async () => {
        const onClick = vi.fn();
        const { user } = renderCard(onClick);

        await user.click(screen.getByRole('link', { name: "Open Martina's profile" }));
        await user.click(screen.getByRole('link', { name: 'See 2 more friends going' }));
        expect(onClick).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'SALSARAVE 2026' }));
        expect(onClick).toHaveBeenCalledWith(event);
    });

    it('uses singular social copy and no image slot when only one friend is going', () => {
        renderCard(vi.fn(), {
            ...event,
            image_url: null,
            friends_going_count: 1,
            friends_going_preview: [friends[0]],
        });

        expect(screen.getByText('Martina')).toBeInTheDocument();
        expect(screen.getByText('is going to')).toBeInTheDocument();
        expect(screen.queryByTestId('friends-going-event-image')).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /more friends going/ })).not.toBeInTheDocument();
    });
});
