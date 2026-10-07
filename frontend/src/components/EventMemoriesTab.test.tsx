import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render';
import { makeUser } from '../test/handlers';
import { server } from '../test/server';
import type { CalendarEvent, EventAssets, EventUserAsset } from '../types';
import EventMemoriesTab from './EventMemoriesTab';

const event: CalendarEvent = {
    event_id: 'evt',
    calendar_id: 'cal',
    title: 'Gala',
    description: null,
    image_url: null,
    location: null,
    latitude: null,
    longitude: null,
    start: '2026-01-01T20:00:00Z',
    end: '2026-01-01T23:00:00Z',
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

const memory = (overrides: Partial<EventUserAsset>): EventUserAsset => ({
    id: 'm1',
    event_id: 'evt',
    kind: 'memory',
    content_type: 'image/webp',
    url: null,
    thumb_url: 'https://signed.test/t.webp',
    full_url: 'https://signed.test/f.webp',
    file_url: null,
    width: null,
    height: null,
    visibility: 'attendees',
    caption: null,
    created_at: '2026-01-02T00:00:00Z',
    is_owner: false,
    owner_display_name: 'Mia',
    owner_avatar_url: null,
    ...overrides,
});

const data = (overrides: Partial<EventAssets>): EventAssets => ({
    event_id: 'evt',
    is_going: true,
    assets: [],
    ticket_count: 0,
    memory_count: 0,
    max_tickets: 2,
    max_memories: 5,
    max_ticket_mb: 5,
    max_memory_mb: 10,
    can_add_ticket: true,
    can_add_memory: true,
    memory_window_opens_at: '2026-01-01T20:00:00Z',
    memory_window_closes_at: '2026-01-31T20:00:00Z',
    ticket_expires_at: '2026-02-01T00:00:00Z',
    ...overrides,
});

function renderTab(body: EventAssets) {
    server.use(
        http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        http.get('*/api/events/evt/assets', () => HttpResponse.json(body)),
    );
    return renderWithProviders(<EventMemoriesTab event={event} />);
}

describe('EventMemoriesTab', () => {
    it('shows own and shared memories with the add tile and window', async () => {
        renderTab(data({ assets: [memory({ caption: 'Best rueda ever' })] }));

        expect(await screen.findByRole('button', { name: 'Best rueda ever' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Add/ })).toBeInTheDocument();
        expect(screen.getByText(/Add memories until/)).toBeInTheDocument();
    });

    it('opens the viewer with Close top-right and no Delete for others\' memories', async () => {
        const { user } = renderTab(data({ is_going: false, can_add_memory: false, assets: [memory({ caption: 'Shared' })] }));

        await user.click(await screen.findByRole('button', { name: 'Shared' }));
        expect(screen.getByRole('dialog', { name: 'Memory' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/\/ 5/)).not.toBeInTheDocument();
    });

    it('shows an empty state when there is nothing to show or add', async () => {
        renderTab(data({ is_going: false, can_add_memory: false }));

        expect(await screen.findByText('No memories shared yet.')).toBeInTheDocument();
    });
});
