import { afterEach, describe, it, expect, vi } from 'vitest';
import { downloadPublishedProgramExport, fetchOptionalAdminEventSchedule, getCalendarFeedUrl } from './api';

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

describe('downloadPublishedProgramExport', () => {
    afterEach(() => vi.restoreAllMocks());

    it('serializes the same schedule filters used by the preview', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('calendar', {
            status: 200,
            headers: { 'content-disposition': 'attachment; filename="program.ics"' },
        }));

        await downloadPublishedProgramExport('event-1', 'ics', {
            days: ['2026-10-16', '2026-10-17'],
            includeCancelled: false,
            instructor: 'Maya',
            contributorIds: [8, 9],
            levelIds: [2, 3],
            activityTypeIds: [4],
        });

        const url = new URL(String(fetchMock.mock.calls[0][0]), window.location.origin);
        expect(url.searchParams.getAll('days')).toEqual(['2026-10-16', '2026-10-17']);
        expect(url.searchParams.get('include_cancelled')).toBe('false');
        expect(url.searchParams.get('instructor')).toBe('Maya');
        expect(url.searchParams.getAll('contributor_ids')).toEqual(['8', '9']);
        expect(url.searchParams.getAll('level_ids')).toEqual(['2', '3']);
        expect(url.searchParams.getAll('activity_type_ids')).toEqual(['4']);
    });
});
