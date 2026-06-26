import { describe, it, expect } from 'vitest';
import { getCalendarFeedUrl } from './api';

// In the Vite dev/test branch resolveApiBase() returns the relative `/api`,
// so the feed URL is resolved against the current origin — fully-qualified is
// required because calendar clients poll it directly.
describe('getCalendarFeedUrl', () => {
    const origin = window.location.origin;

    it('defaults to the "all" scope', () => {
        expect(getCalendarFeedUrl('tok-123')).toBe(
            `${origin}/api/share/calendar/tok-123.ics?scope=all`,
        );
    });

    it('reflects the requested scope', () => {
        expect(getCalendarFeedUrl('tok-123', 'saved')).toContain('scope=saved');
        expect(getCalendarFeedUrl('tok-123', 'going')).toContain('scope=going');
    });

    it('url-encodes the token', () => {
        expect(getCalendarFeedUrl('a/b c')).toContain('/share/calendar/a%2Fb%20c.ics');
    });
});
