import { describe, expect, it } from 'vitest';
import { cleanEventDescription } from './eventDescription';

describe('cleanEventDescription', () => {
    it('removes standalone extracted-link lines with localized labels', () => {
        expect(cleanEventDescription([
            'Paris Salsa Marathon',
            'Event: https://facebook.com/events/s/paris-salsa-marathon-2026/1577414196613079/',
            '',
            'Évènement : https://facebook.com/events/s/porto-salsa-weekend-2026/1702938200689969/',
            'https://tickets.example.test/paris-salsa-marathon',
            '',
            'Three days of dancing.',
        ].join('\n'))).toBe('Paris Salsa Marathon\n\nThree days of dancing.');
    });

    it('keeps links embedded in prose', () => {
        const description = 'Details at https://facebook.com/events/123 or at the venue.';
        expect(cleanEventDescription(description)).toBe(description);
    });

    it('returns an empty description when every line is an extracted link', () => {
        expect(cleanEventDescription('Tickets: https://example.test/tickets')).toBe('');
    });
});
