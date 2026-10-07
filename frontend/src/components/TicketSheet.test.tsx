import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render';
import { makeUser } from '../test/handlers';
import { server } from '../test/server';
import type { CalendarEvent, EventAssets, EventUserAsset } from '../types';
import TicketSheet from './TicketSheet';

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

function renderSheet(data: EventAssets, start = '2099-01-01T20:00:00Z', onClose = vi.fn()) {
    server.use(
        http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        http.get('*/api/events/evt/assets', () => HttpResponse.json(data)),
    );
    return renderWithProviders(<TicketSheet event={event(start)} onClose={onClose} />);
}

describe('TicketSheet', () => {
    it('folds the add options behind a + tile once a ticket exists', async () => {
        const { user } = renderSheet(assets({ assets: [asset({})], ticket_count: 1 }));

        const dialog = await screen.findByRole('dialog', { name: /My ticket/ });
        expect(await within(dialog).findByText('1 / 2')).toBeInTheDocument();
        expect(within(dialog).getByRole('link', { name: /PDF ticket/ })).toHaveAttribute('href', 'https://signed.test/ticket.pdf');
        expect(within(dialog).queryByRole('button', { name: /Paste ticket link/ })).not.toBeInTheDocument();

        const add = within(dialog).getByRole('button', { name: 'Add another ticket' });
        expect(add).toHaveAttribute('aria-expanded', 'false');
        await user.click(add);
        expect(add).toHaveAttribute('aria-expanded', 'true');
        expect(within(dialog).getByRole('button', { name: /Choose file/ })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /Paste ticket link/ })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /Take a photo/ })).toBeInTheDocument();

        await user.click(add);
        expect(within(dialog).queryByRole('button', { name: /Paste ticket link/ })).not.toBeInTheDocument();
    });

    it('shows the add options directly with no + tile when there is no ticket', async () => {
        renderSheet(assets({}));

        const dialog = await screen.findByRole('dialog', { name: /My ticket/ });
        expect(await within(dialog).findByRole('button', { name: /Paste ticket link/ })).toBeInTheDocument();
        expect(within(dialog).queryByRole('button', { name: 'Add another ticket' })).not.toBeInTheDocument();
    });

    it('deletes a ticket from the thumbnail badge after confirming', async () => {
        let deleted = false;
        server.use(
            http.delete('*/api/event-assets/a1', () => {
                deleted = true;
                return HttpResponse.json(assets({}));
            }),
        );
        const { user } = renderSheet(assets({ assets: [asset({})], ticket_count: 1 }));

        await user.click(await screen.findByRole('button', { name: 'Delete ticket' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));

        await vi.waitFor(() => expect(deleted).toBe(true));
        expect(await screen.findByText('0 / 2')).toBeInTheDocument();
    });

    it('replaces the add options with the limit at the ticket limit', async () => {
        renderSheet(assets({
            assets: [asset({ id: 'a1' }), asset({ id: 'a2', kind: 'ticket_link', url: 'https://tix.example/1', file_url: null })],
            ticket_count: 2,
            can_add_ticket: false,
        }));

        expect(await screen.findByText('Limit reached (2).')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Paste ticket link/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add another ticket' })).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: /tix\.example/ })).toHaveAttribute('href', 'https://tix.example/1');
    });

    it('lists Take a photo last and has no close button', async () => {
        renderSheet(assets({ ticket_likely: true }));

        const dialog = await screen.findByRole('dialog', { name: /My ticket/ });
        const options = await within(dialog).findAllByRole('button', { name: /Choose file|Paste ticket link|Take a photo/ });
        expect(options.map((o) => o.textContent)).toEqual(['📄 Choose file (PDF, image)', '🔗 Paste ticket link', '📷 Take a photo']);
        expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
        expect(within(dialog).queryByRole('button', { name: 'No ticket needed' })).not.toBeInTheDocument();
    });

    it('asks non-going users to RSVP first', async () => {
        renderSheet(assets({ is_going: false, can_add_ticket: false }));

        expect(await screen.findByText(/Mark yourself as going/)).toBeInTheDocument();
    });
});
