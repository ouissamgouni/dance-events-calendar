import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import PeopleTab from './PeopleTab';
import { renderWithProviders } from '../../test/render';
import { makeUser } from '../../test/handlers';
import { server } from '../../test/server';

function attendee(
    user_id: string,
    overrides: Record<string, unknown> = {},
) {
    return {
        user_id,
        display_name: user_id,
        avatar_url: null,
        handle: user_id,
        attendance_status: 'going',
        is_friend: false,
        mutual_friend_count: 0,
        ...overrides,
    };
}

describe('PeopleTab', () => {
    it('uses a neutral Going section and shows going and interested counts', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.post('*/api/events/attendance-summary', () =>
                HttpResponse.json([
                    {
                        event_id: 'event-1',
                        total_going: 18,
                        total_saved: 7,
                        public_going: 1,
                        anonymous_going: 17,
                        can_view_attendees: true,
                        viewer_is_sharing: false,
                        preview_attendees: [],
                    },
                ]),
            ),
            http.get('*/api/events/:eventId/attendees', () =>
                HttpResponse.json([
                    attendee('Public attendee'),
                    attendee('Interested attendee', { attendance_status: 'interested' }),
                ]),
            ),
        );

        renderWithProviders(<PeopleTab eventId="event-1" />);

        expect(await screen.findByRole('heading', { name: '18 going · 7 interested' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Going · 1' })).toBeInTheDocument();
        expect(screen.queryByText(/Other people going/)).not.toBeInTheDocument();
    });

    it('orders friend and following sections before other attendees', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/events/:eventId/attendees', () =>
                HttpResponse.json([
                    attendee('Other'),
                    attendee('Following', { viewer_follow_status: 'approved' }),
                    attendee('Friend', { is_friend: true, viewer_follow_status: 'approved' }),
                ]),
            ),
        );

        renderWithProviders(<PeopleTab eventId="event-1" />);

        await screen.findByRole('heading', { name: '3 going · 0 interested' });
        const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
        expect(headings).toEqual([
            '3 going · 0 interested',
            'Friends going · 1',
            'Following going · 1',
            'Other people going · 1',
        ]);
    });
});
