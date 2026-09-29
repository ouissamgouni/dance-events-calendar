import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import AttendeeAvatarStack, { shouldHideSoloCurrentUser } from './AttendeeAvatarStack';
import { renderWithProviders } from '../test/render';
import { makeUser } from '../test/handlers';
import { server } from '../test/server';

describe('shouldHideSoloCurrentUser', () => {
    it('hides only a sole attendee matching the authenticated viewer', () => {
        expect(shouldHideSoloCurrentUser(1, ['user-1'], 'user-1')).toBe(true);
        expect(shouldHideSoloCurrentUser(1, ['user-2'], 'user-1')).toBe(false);
        expect(shouldHideSoloCurrentUser(2, ['user-1'], 'user-1')).toBe(false);
        expect(shouldHideSoloCurrentUser(1, ['user-1'])).toBe(false);
    });
});

describe('AttendeeAvatarStack relationship hierarchy', () => {
    it('orders relationships first and renders public attendees smaller in Tribe mode', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.post('*/api/events/attendance-summary', () =>
                HttpResponse.json([
                    {
                        event_id: 'event-1',
                        total_going: 3,
                        total_saved: 0,
                        public_going: 3,
                        anonymous_going: 0,
                        can_view_attendees: true,
                        viewer_is_sharing: false,
                        preview_attendees: [
                            { user_id: 'stranger', display_name: 'Stranger', avatar_url: '/stranger.jpg', handle: 'stranger', is_friend: false },
                            { user_id: 'followed', display_name: 'Followed', avatar_url: '/followed.jpg', handle: 'followed', viewer_follow_status: 'approved', is_friend: false },
                            { user_id: 'friend', display_name: 'Friend', avatar_url: '/friend.jpg', handle: 'friend', viewer_follow_status: 'approved', is_friend: true },
                        ],
                    },
                ]),
            ),
        );

        renderWithProviders(createElement(AttendeeAvatarStack, {
            eventId: 'event-1',
            size: 'lg',
            layout: 'faces',
            relationshipHierarchy: true,
        }));

        await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3));
        const avatars = screen.getAllByRole('img');
        expect(avatars.map((avatar) => avatar.getAttribute('alt'))).toEqual([
            'Friend',
            'Followed',
            'Stranger',
        ]);
        expect(avatars[0]).toHaveClass('w-9', 'h-9');
        expect(avatars[1]).toHaveClass('w-9', 'h-9');
        expect(avatars[2]).toHaveClass('w-5', 'h-5');
    });
});
