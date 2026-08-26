import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render';
import { server } from '../test/server';
import MyEventsAddSearch from './MyEventsAddSearch';

describe('MyEventsAddSearch', () => {
    it('searches historical unattended events and offers Suggest when empty', async () => {
        let requestedUrl = '';
        server.use(
            http.get('*/api/events/search', ({ request }) => {
                requestedUrl = request.url;
                return HttpResponse.json([]);
            }),
        );
        const onSuggest = vi.fn();
        const { user } = renderWithProviders(<MyEventsAddSearch tab="past" onSuggest={onSuggest} />);

        await user.type(screen.getByRole('textbox', { name: 'Search events to add' }), 'salsa');

        await waitFor(() => expect(requestedUrl).not.toBe(''));
        const query = new URL(requestedUrl).searchParams;
        expect(query.get('include_past')).toBe('true');
        expect(query.get('exclude_attended')).toBe('true');

        await user.click(await screen.findByRole('button', { name: 'Suggest an event' }));
        expect(onSuggest).toHaveBeenCalledOnce();
    });
});
