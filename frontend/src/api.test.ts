import { afterEach, describe, it, expect, vi } from 'vitest';
import { fetchOptionalAdminEventSchedule, getCalendarFeedUrl } from './api';

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
        expect(getCalendarFeedUrl('tok-123', 'saved')).toContain('view=saved');
        expect(getCalendarFeedUrl('tok-123', 'going')).toContain('scope=going');
    });

    it('url-encodes the token', () => {
        expect(getCalendarFeedUrl('a/b c')).toContain('/share/calendar/a%2Fb%20c.ics');
    });
});

describe('fetchOptionalAdminEventSchedule', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns null when the event has no schedule', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

        await expect(fetchOptionalAdminEventSchedule('event-without-program')).resolves.toBeNull();
    });

    it('preserves errors other than a missing schedule', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ detail: 'Schedule service unavailable' }),
            { status: 503, headers: { 'content-type': 'application/json' } },
        ));

        await expect(fetchOptionalAdminEventSchedule('event-without-program')).rejects.toThrow('Schedule service unavailable');
    });
});
