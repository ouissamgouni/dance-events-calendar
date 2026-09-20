import { describe, expect, it } from 'vitest';
import { cleanEventDescription } from './eventDescription';

describe('cleanEventDescription', () => {
    it('removes standalone labeled Facebook event links', () => {
        expect(cleanEventDescription([
            'Paris Salsa Marathon',
            'Event: https://facebook.com/events/s/paris-salsa-marathon-2026/1577414196613079/',
            '',
            'Three days of dancing.',
        ].join('\n'))).toBe('Paris Salsa Marathon\n\nThree days of dancing.');
    });

    it('keeps inline and unlabeled Facebook event links', () => {
        const description = 'Details at https://facebook.com/events/123 or at the venue.\nhttps://facebook.com/events/456';
        expect(cleanEventDescription(description)).toBe(description);
    });
});
