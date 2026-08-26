import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext';
import { renderWithProviders } from '../test/render';
import type { CalendarEvent } from '../types';
import MyEventsList from './MyEventsList';

function event(id: string, imageUrl: string | null): CalendarEvent {
    return {
        event_id: id,
        calendar_id: 'cal',
        title: `Event ${id}`,
        description: null,
        image_url: imageUrl,
        location: 'Paris, France',
        city: 'Paris',
        country: 'France',
        latitude: 48.8,
        longitude: 2.3,
        start: '2026-09-05T20:00:00Z',
        end: '2026-09-05T22:00:00Z',
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: true,
        links: null,
        tags: [],
    };
}

function renderList(tab: 'upcoming' | 'saved' | 'past', events: CalendarEvent[]) {
    return renderWithProviders(
        <FeatureFlagsProvider>
            <MyEventsList events={events} tab={tab} onEventClick={vi.fn()} />
        </FeatureFlagsProvider>,
        { routerEntries: ['/mine/calendar'] },
    );
}

describe('MyEventsList', () => {
    it('groups rows by month without map sequence numbers or Upcoming actions', () => {
        renderList('upcoming', [event('one', '/event.jpg'), event('two', null)]);

        expect(screen.getByText('September 2026')).toBeInTheDocument();
        expect(screen.getAllByTestId('my-events-row')).toHaveLength(2);
        expect(screen.getAllByTestId('my-events-row-image')).toHaveLength(1);
        expect(screen.queryByText('#1')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save event' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: "I'm going" })).not.toBeInTheDocument();
    });

    it('removes a failed image and shows compact Saved actions', () => {
        renderList('saved', [event('saved', '/broken.jpg')]);

        fireEvent.error(screen.getByTestId('my-events-row-image'));
        expect(screen.queryByTestId('my-events-row-image')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save event' })).toBeInTheDocument();
        const going = screen.getByRole('button', { name: "I'm going" });
        expect(going.querySelector('[data-icon-family="hand"]')).toBeInTheDocument();
    });
});
