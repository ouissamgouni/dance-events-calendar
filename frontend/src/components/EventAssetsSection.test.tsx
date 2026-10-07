import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlagsContext, defaultFlags } from '../context/FeatureFlagsContext';
import { renderWithProviders } from '../test/render';
import { makeUser } from '../test/handlers';
import { server } from '../test/server';
import type { CalendarEvent, EventAssets, EventUserAsset } from '../types';
import EventAssetsSection from './EventAssetsSection';

const event = (start: string): CalendarEvent => ({
    event_id: 'evt',
    calendar_id: 'cal',
    title: 'Gala',
    description: null,
    image_url: null,
    location: null,
    latitude: null,
    longitude: null,
    start,
    end: start,
    all_day: false,
    color: null,
    view_count: 0,
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: true,
    links: null,
    tags: [],
});

const asset = (overrides: Partial<EventUserAsset>): EventUserAsset => ({
    id: 'a1',
    event_id: 'evt',
    kind: 'ticket',
    content_type: 'application/pdf',
    url: null,
    thumb_url: null,
    full_url: null,
    file_url: 'https://signed.test/ticket.pdf',
    width: null,
    height: null,
    visibility: 'private',
    caption: null,
    created_at: '2026-10-01T00:00:00Z',
    is_owner: true,
    owner_display_name: null,
    owner_avatar_url: null,
    ...overrides,
});

const assets = (overrides: Partial<EventAssets>): EventAssets => ({
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
    can_add_memory: false,
    memory_window_opens_at: '2026-10-10T20:00:00Z',
    memory_window_closes_at: '2026-11-09T20:00:00Z',
    ticket_expires_at: '2026-11-10T00:00:00Z',
    ...overrides,
});

function renderSection(data: EventAssets, start = '2099-01-01T20:00:00Z', isPast = false, onFetch = () => { }) {
    server.use(
        http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        http.get('*/api/events/evt/assets', () => {
            onFetch();
            return HttpResponse.json(data);
        }),
    );
    const flags = { ...defaultFlags, eventTicketsEnabled: true, eventMemoriesEnabled: true };
    return renderWithProviders(
        <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
            <EventAssetsSection event={event(start)} isPast={isPast} />
        </FeatureFlagsContext.Provider>,
    );
}

describe('EventAssetsSection', () => {
    it('shows the ticket tile, counter and opens the add sheet', async () => {
        const { user } = renderSection(assets({ assets: [asset({})], ticket_count: 1 }));

        expect(await screen.findByText('1 / 2')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /PDF ticket/ })).toHaveAttribute('href', 'https://signed.test/ticket.pdf');
        expect(screen.queryByText(/Memories/)).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Add' }));
        expect(screen.getByRole('dialog', { name: 'Add ticket' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Paste ticket link/ })).toBeInTheDocument();
    });

    it('disables adding at the ticket limit', async () => {
        renderSection(assets({
            assets: [asset({ id: 'a1' }), asset({ id: 'a2', kind: 'ticket_link', url: 'https://tix.example/1', file_url: null })],
            ticket_count: 2,
            can_add_ticket: false,
        }));

        expect(await screen.findByRole('button', { name: /Limit reached \(2\)/ })).toBeDisabled();
        expect(screen.getByRole('link', { name: /tix\.example/ })).toHaveAttribute('href', 'https://tix.example/1');
    });

    it('lets a ticket-likely event be marked "No ticket needed" and undone', async () => {
        let notNeeded = false;
        server.use(
            http.put('*/api/events/evt/ticket-not-needed', () => {
                notNeeded = true;
                return HttpResponse.json(assets({ ticket_likely: true, ticket_not_needed: true }));
            }),
            http.delete('*/api/events/evt/ticket-not-needed', () => {
                notNeeded = false;
                return HttpResponse.json(assets({ ticket_likely: true, ticket_not_needed: false }));
            }),
        );
        const { user } = renderSection(assets({ ticket_likely: true }));

        await user.click(await screen.findByRole('button', { name: 'No ticket needed' }));
        expect(notNeeded).toBe(true);
        expect(await screen.findByText(/No ticket needed ·/)).toBeInTheDocument();
        expect(screen.queryByText(/My ticket/)).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Undo' }));
        expect(await screen.findByText(/My ticket/)).toBeInTheDocument();
        expect(notNeeded).toBe(false);
    });

    it('shows only a quiet Add ticket link on events that rarely need one', async () => {
        const { user } = renderSection(assets({ ticket_likely: false }));

        await user.click(await screen.findByRole('button', { name: /Add ticket/ }));
        expect(screen.getByRole('dialog', { name: 'Add ticket' })).toBeInTheDocument();
        expect(screen.queryByText(/My ticket/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'No ticket needed' })).not.toBeInTheDocument();
    });

    it('renders nothing for a user who is not going and sees no memories', async () => {
        let fetched = false;
        const { container } = renderSection(assets({ is_going: false, can_add_ticket: false }), undefined, false, () => { fetched = true; });

        await waitFor(() => expect(fetched).toBe(true));
        expect(container.querySelector('#ticket')).toBeNull();
        expect(container.querySelector('#memories')).toBeNull();
    });

    it('shows shared memories to a non-attendee with the owner marker', async () => {
        renderSection(
            assets({
                is_going: false,
                can_add_ticket: false,
                assets: [asset({ kind: 'memory', is_owner: false, owner_display_name: 'Mia', thumb_url: 'https://signed.test/t.webp', full_url: 'https://signed.test/f.webp', file_url: null, caption: 'Best rueda ever' })],
            }),
            '2026-01-01T20:00:00Z',
            true,
        );

        expect(await screen.findByRole('button', { name: 'Best rueda ever' })).toBeInTheDocument();
        expect(screen.queryByText(/My ticket/)).not.toBeInTheDocument();
        expect(screen.queryByText(/\/ 5/)).not.toBeInTheDocument();
    });
});
