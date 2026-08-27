import { describe, expect, it } from 'vitest';
import { shouldHideSoloCurrentUser } from './AttendeeAvatarStack';

describe('shouldHideSoloCurrentUser', () => {
    it('hides only a sole attendee matching the authenticated viewer', () => {
        expect(shouldHideSoloCurrentUser(1, ['user-1'], 'user-1')).toBe(true);
        expect(shouldHideSoloCurrentUser(1, ['user-2'], 'user-1')).toBe(false);
        expect(shouldHideSoloCurrentUser(2, ['user-1'], 'user-1')).toBe(false);
        expect(shouldHideSoloCurrentUser(1, ['user-1'])).toBe(false);
    });
});
