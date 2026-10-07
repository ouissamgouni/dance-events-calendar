import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
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

function renderTab(body: EventAssets, routerEntries?: string[]) {
    server.use(
        http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        http.get('*/api/events/evt/assets', () => HttpResponse.json(body)),
    );
    return renderWithProviders(<EventMemoriesTab event={event} />, { routerEntries });
}

const trailNames = () =>
    screen.getAllByTestId('memory-trail').map((trail) => within(trail).getByRole('heading').textContent);

describe('EventMemoriesTab', () => {
    it('groups memories into one trail per person: you, friends, then others', async () => {
        renderTab(data({
            assets: [
                memory({ id: 'o1', owner_display_name: 'Olga', owner_handle: 'olga', created_at: '2026-01-05T00:00:00Z' }),
                memory({ id: 'f1', owner_display_name: 'Fred', owner_handle: 'fred', owner_is_friend: true }),
                memory({ id: 'f2', owner_display_name: 'Fred', owner_handle: 'fred', owner_is_friend: true }),
                memory({ id: 'me', is_owner: true, visibility: 'private', owner_display_name: 'Me' }),
            ],
        }));

        await screen.findAllByTestId('memory-trail');
        expect(trailNames()).toEqual(['You· 1', 'Fred· 2', 'Olga· 1']);
        expect(screen.getByRole('link', { name: 'Fred' })).toHaveAttribute('href', '/u/fred');
        // Visibility badges only on your own photos.
        expect(screen.getAllByLabelText('Only me')).toHaveLength(1);
        expect(screen.queryByLabelText('Friends & people who went')).not.toBeInTheDocument();
    });

    it('counts only what the API returned and caps each trail with See all', async () => {
        const many = Array.from({ length: 12 }, (_, i) => memory({ id: `m${i}`, owner_handle: 'mia', caption: `p${i}` }));
        const { user } = renderTab(data({ assets: many }));

        expect(await screen.findByRole('button', { name: 'See all 12' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'p10' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'See all 12' }));
        expect(screen.getByRole('dialog', { name: 'Memory' })).toHaveTextContent('11 / 12');
    });

    it('filters to friends or mine', async () => {
        const { user } = renderTab(data({
            assets: [
                memory({ id: 'f1', owner_display_name: 'Fred', owner_handle: 'fred', owner_is_friend: true }),
                memory({ id: 'o1', owner_display_name: 'Olga', owner_handle: 'olga' }),
                memory({ id: 'me', is_owner: true }),
            ],
        }));

        await user.click(await screen.findByRole('button', { name: 'Friends' }));
        expect(trailNames()).toEqual(['Fred· 1']);
        await user.click(screen.getByRole('button', { name: 'Mine' }));
        expect(trailNames()).toEqual(['You· 1']);
    });

    it('highlights the trail from a ?by= deep link', async () => {
        renderTab(
            data({ assets: [memory({ id: 'f1', owner_display_name: 'Fred', owner_handle: 'fred' })] }),
            ['/event/evt?by=fred'],
        );

        await screen.findByRole('link', { name: 'Fred' });
        const trail = document.getElementById('memories-by-fred');
        expect(trail).not.toBeNull();
        expect(trail?.className).toContain('ring-action');
    });

    it('asks who can see a batch before uploading and warns when it reveals a non-public RSVP', async () => {
        // Reading multipart bodies hangs under jsdom+MSW, so capture the form fields instead.
        const append = vi.spyOn(FormData.prototype, 'append');
        let uploaded = false;
        server.use(
            http.post('*/api/events/evt/assets', () => {
                uploaded = true;
                return HttpResponse.json(data({}));
            }),
        );
        const { user } = renderTab(data({}));

        await screen.findByRole('button', { name: /Add/ });
        const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
        await user.upload(screen.getByTestId('memory-file-input'), file);

        const dialog = screen.getByRole('dialog', { name: /Who can see this photo/ });
        expect(within(dialog).getByRole('radio', { name: /^👥 Friends/ })).toBeChecked();
        expect(within(dialog).queryByRole('note')).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole('radio', { name: /people who went/ }));
        expect(within(dialog).getByRole('note')).toHaveTextContent(/they'll know you went/);
        await user.click(within(dialog).getByRole('button', { name: 'Upload' }));

        await waitFor(() => expect(uploaded).toBe(true));
        expect(append).toHaveBeenCalledWith('visibility', 'attendees');
        expect(localStorage.getItem('movida_memory_visibility')).toBe('attendees');
        append.mockRestore();
    });

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
