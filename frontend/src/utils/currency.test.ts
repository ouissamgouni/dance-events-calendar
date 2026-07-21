import { describe, expect, it } from 'vitest';
import { currencySymbol } from './currency';

describe('currencySymbol', () => {
    it('resolves common ISO codes to their narrow sign', () => {
        expect(currencySymbol('EUR')).toBe('€');
        expect(currencySymbol('USD')).toBe('$');
        expect(currencySymbol('GBP')).toBe('£');
    });

    it('returns an empty string for null/undefined', () => {
        expect(currencySymbol(null)).toBe('');
        expect(currencySymbol(undefined)).toBe('');
    });

    it('falls back to the raw code for an unrecognized currency', () => {
        expect(currencySymbol('NOTACODE')).toBe('NOTACODE');
    });
});
