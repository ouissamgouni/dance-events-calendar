import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../types';
import YourNextEventsRail from './YourNextEventsRail';

const event: CalendarEvent = {
    event_id: 'evt-next-1',
    calendar_id: 'cal-1',
    title: 'Batignolles Bachata',
    description: null,
    image_url: '/event.jpg',
    location: 'Paris, France',
    latitude: null,
    longitude: null,
    start: '2027-09-05T20:00:00',
    end: '2027-09-05T23:00:00',
    all_day: false,
    color: null,
    view_count: 0,
    friends_going_count: 5,
    friends_going_preview: [
        { user_id: 'friend-1', display_name: 'Paul Martin', avatar_url: null, handle: 'paul' },
        { user_id: 'friend-2', display_name: 'Ana Diaz', avatar_url: '/ana.jpg', handle: 'ana' },
        { user_id: 'friend-3', display_name: 'Mia Chen', avatar_url: '/mia.jpg', handle: 'mia' },
        { user_id: 'friend-4', display_name: 'Luis Costa', avatar_url: '/luis.jpg', handle: 'luis' },
    ],
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: false,
    links: null,
    tags: [],
};

function renderRail(events: CalendarEvent[], onEventClick = vi.fn(), loading = false) {
    return {
        onEventClick,
        ...render(
            <MemoryRouter>
                <YourNextEventsRail events={events} onEventClick={onEventClick} loading={loading} />
            </MemoryRouter>,
        ),
    };
}

describe('YourNextEventsRail', () => {
    it('renders only the first event and opens the whole card', async () => {
        const user = userEvent.setup();
        const second = { ...event, event_id: 'evt-next-2', title: 'Second event' };
        const { onEventClick } = renderRail([event, second]);

        expect(screen.getByText(event.title)).toBeInTheDocument();
        expect(screen.queryByText(second.title)).not.toBeInTheDocument();
        expect(screen.queryByTestId('your-next-event-image')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Paul')).toHaveTextContent('P');
        expect(screen.getByRole('img', { name: 'Ana' })).toHaveAttribute('src', '/ana.jpg');
        expect(screen.getByRole('img', { name: 'Mia' })).toHaveAttribute('src', '/mia.jpg');
        expect(screen.queryByRole('img', { name: 'Luis' })).not.toBeInTheDocument();
        expect(screen.getByText('+2 friends going')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Next up' })).toHaveClass('text-lg', 'font-bold', 'text-ink');
        expect(screen.getByRole('link', { name: '2 upcoming' })).toHaveClass('text-sm', 'font-semibold', 'text-action');

        const countdown = screen.getByTestId('next-up-countdown');
        const avatarStack = screen.getByTestId('next-up-avatar-stack');
        expect(screen.getByLabelText('Paul')).toHaveClass('h-5', 'w-5');
        expect(countdown.compareDocumentPosition(avatarStack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        await user.click(screen.getByRole('button', { name: /Open Batignolles Bachata/ }));
        expect(onEventClick).toHaveBeenCalledWith(event);
    });

    it('links directly to the event when no click override is provided', () => {
        render(
            <MemoryRouter>
                <YourNextEventsRail events={[event]} />
            </MemoryRouter>,
        );

        expect(screen.getByTestId('your-next-event-card')).toHaveAttribute('href', '/event/evt-next-1');
    });

    it.each([
        { total: 1, copy: '1 upcoming' },
        { total: 2, copy: '2 upcoming' },
        { total: 3, copy: '3 upcoming' },
        { total: 5, copy: '5 upcoming' },
    ])('shows the correct link for $total events', ({ total, copy }) => {
        const events = Array.from({ length: total }, (_, index) => ({ ...event, event_id: `evt-${index}` }));
        renderRail(events);

        expect(screen.getByRole('link', { name: copy })).toHaveAttribute('href', '/mine/calendar?filter=going');
    });

    it('uses the shared image-free Next Up card style', () => {
        renderRail([event]);
        expect(screen.queryByTestId('your-next-event-image')).not.toBeInTheDocument();
        expect(screen.getByTestId('your-next-event-card')).toHaveClass('bg-brand/10');
    });

    it('renders the compact empty state after loading', () => {
        const { rerender } = render(
            <MemoryRouter>
                <YourNextEventsRail events={[]} onEventClick={vi.fn()} loading />
            </MemoryRouter>,
        );
        expect(screen.queryByTestId('your-next-events-rail')).not.toBeInTheDocument();

        rerender(
            <MemoryRouter>
                <YourNextEventsRail events={[]} onEventClick={vi.fn()} />
            </MemoryRouter>,
        );
        expect(screen.getByText('No upcoming events')).toBeInTheDocument();
        expect(screen.getByText('Find your next dance event')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Explore →' })).toHaveAttribute('href', '/');
    });
});
