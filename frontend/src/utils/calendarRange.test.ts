import { describe, expect, it } from 'vitest';
import { toInclusiveCalendarRange } from './calendarRange';

describe('toInclusiveCalendarRange', () => {
    it('converts an exclusive month end to the inclusive previous day', () => {
        expect(toInclusiveCalendarRange(
            new Date(2026, 7, 30),
            new Date(2026, 9, 11),
        )).toEqual({ startDate: '2026-08-30', endDate: '2026-10-10' });
    });

    it('handles a year boundary in local calendar time', () => {
        expect(toInclusiveCalendarRange(
            new Date(2026, 11, 20),
            new Date(2027, 1, 1),
        )).toEqual({ startDate: '2026-12-20', endDate: '2027-01-31' });
    });
});
