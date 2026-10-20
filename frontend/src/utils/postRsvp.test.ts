import { describe, expect, it } from 'vitest';
import type { Attendee } from '../types';
import { buildEventShareUrl, peopleTrailLabel, splitRsvpPeople } from './postRsvp';

function a(user_id: string, overrides: Partial<Attendee> = {}): Attendee {
    return {
        user_id,
        display_name: user_id,
        avatar_url: null,
        handle: user_id,
        attendance_status: 'going',
        ...overrides,
    };
}

describe('splitRsvpPeople', () => {
    it('separates your people from followable attendees, excluding self, interested and pending', () => {
        const { yourPeople, alsoGoing, alsoGoingTotal } = splitRsvpPeople([
            a('me'),
            a('friend', { is_friend: true, viewer_follow_status: 'approved' }),
            a('followed', { viewer_follow_status: 'approved' }),
            a('requested', { viewer_follow_status: 'pending' }),
            a('saver', { attendance_status: 'interested' }),
            a('nohandle', { handle: null }),
            a('stranger'),
        ], 'me');

        expect(yourPeople.map((p) => p.user_id)).toEqual(['friend', 'followed']);
        expect(alsoGoing.map((p) => p.user_id)).toEqual(['stranger']);
        expect(alsoGoingTotal).toBe(1);
    });

    it('ranks by mutual friends, keeps order on ties, and caps at 3', () => {
        const { alsoGoing, alsoGoingTotal } = splitRsvpPeople([
            a('first'),
            a('second'),
            a('popular', { mutual_friend_count: 4 }),
            a('some', { mutual_friend_count: 1 }),
            a('third'),
        ], 'me');

        expect(alsoGoing.map((p) => p.user_id)).toEqual(['popular', 'some', 'first']);
        expect(alsoGoingTotal).toBe(5);
    });
});

describe('buildEventShareUrl', () => {
    it('adds attribution and the invite code only for a known sharer', () => {
        expect(buildEventShareUrl('https://x.app', 'e 1')).toBe('https://x.app/event/e%201');
        expect(buildEventShareUrl('https://x.app', 'e1', 'abc', 'INV1')).toBe(
            'https://x.app/event/e1?ref=share&src=abc&inv=INV1',
        );
        expect(buildEventShareUrl('https://x.app', 'e1', null, 'INV1')).toBe('https://x.app/event/e1');
    });
});

describe('peopleTrailLabel', () => {
    it('names the first two and counts the rest', () => {
        expect(peopleTrailLabel([a('Ana')])).toBe('Ana');
        expect(peopleTrailLabel([a('Ana'), a('Leo'), a('Mia'), a('Sam')])).toBe('Ana, Leo + 2 more');
    });
});
