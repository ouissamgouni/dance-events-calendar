import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render';
import { makeProfile, makeUser } from '../test/handlers';
import { server } from '../test/server';
import OrganizerClaimSheet from './OrganizerClaimSheet';

const EVENT = { event_id: 'evt-1', title: 'Salsa Friday', start: '2099-01-01T20:00:00Z' };

describe('OrganizerClaimSheet', () => {
    it('unlocks once bio and a social link are added in place, then claims the event', async () => {
        let claimed: unknown = null;
        const base = makeProfile({ handle: 'testdancer', is_self: true });
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/social/users/testdancer', () => HttpResponse.json(base)),
            http.get('*/api/me/organizer-claims', () => HttpResponse.json([])),
            http.patch('*/api/social/me/bio', () => HttpResponse.json({ ...base, bio: 'I run Salsa Friday' })),
            http.patch('*/api/social/me/social-links', () =>
                HttpResponse.json({ ...base, bio: 'I run Salsa Friday', instagram_url: 'https://instagram.com/me' }),
            ),
            http.post('*/api/me/organizer-claims/events', async ({ request }) => {
                claimed = await request.json();
                return HttpResponse.json({ id: 'c1', user_id: 'user-1', kind: 'badge', status: 'pending', admin_notes: null, reviewed_at: null, reviewed_by: null, created_at: '', events: [] });
            }),
        );
        const { user } = renderWithProviders(<OrganizerClaimSheet initialEvent={EVENT} onClose={() => { }} />);

        const send = await screen.findByRole('button', { name: 'Send request' });
        expect(send).toBeDisabled();
        expect(screen.getByText('Salsa Friday')).toBeInTheDocument();

        await user.type(await screen.findByLabelText('Bio'), 'I run Salsa Friday');
        await user.click(screen.getByRole('button', { name: 'Save bio' }));
        expect(await screen.findByText('Bio added')).toBeInTheDocument();
        expect(send).toBeDisabled();

        await user.type(screen.getByPlaceholderText('@handle'), 'me');
        await user.click(screen.getByRole('button', { name: 'Save link' }));
        await waitFor(() => expect(send).toBeEnabled());

        await user.click(send);
        expect(await screen.findByText('Request sent')).toBeInTheDocument();
        expect(claimed).toEqual({ event_ids: ['evt-1'] });
    });
});
