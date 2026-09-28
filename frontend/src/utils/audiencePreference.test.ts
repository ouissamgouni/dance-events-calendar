import { beforeEach, describe, expect, it } from 'vitest';
import { defaultRsvpAudienceFor } from './audiencePreference';

describe('defaultRsvpAudienceFor', () => {
    beforeEach(() => localStorage.clear());

    it('prefers the account RSVP default over the last-used audience', () => {
        localStorage.setItem('audience.lastUsed.dancer', 'private');

        expect(defaultRsvpAudienceFor({
            user_id: 'dancer',
            share_attendance_default_audience: 'friends',
        })).toBe('friends');
    });

    it('falls back to the last-used audience and legacy account setting', () => {
        localStorage.setItem('audience.lastUsed.dancer', 'friends');

        expect(defaultRsvpAudienceFor({ user_id: 'dancer' })).toBe('friends');
        expect(defaultRsvpAudienceFor({
            user_id: 'other-dancer',
            share_attendance_default: false,
        })).toBe('private');
        expect(defaultRsvpAudienceFor({ user_id: 'new-dancer' })).toBe('public');
    });
});
