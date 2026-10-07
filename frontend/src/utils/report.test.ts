import { describe, expect, it } from 'vitest';
import { reportMailto } from './report';

describe('reportMailto', () => {
    it('addresses support with the reported link and a good-faith statement', () => {
        const href = reportMailto('review', 'https://joinmovida.com/event/e1', 'review r1');
        const url = new URL(href);

        expect(url.protocol).toBe('mailto:');
        expect(url.pathname).toBe('support@joinmovida.com');
        expect(url.searchParams.get('subject')).toBe('Report: review');
        const body = url.searchParams.get('body') ?? '';
        expect(body).toContain('Link: https://joinmovida.com/event/e1');
        expect(body).toContain('Reference: review r1');
        expect(body).toContain('good faith');
    });
});
