import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext';
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

        expect(screen.getByText('Searching past events only. Type at least 2 letters to find past events.')).toBeInTheDocument();
        await user.type(screen.getByRole('textbox', { name: 'Search events to add' }), 'salsa');

        await waitFor(() => expect(requestedUrl).not.toBe(''));
        const query = new URL(requestedUrl).searchParams;
        expect(query.get('include_past')).toBe('true');
        expect(query.get('exclude_attended')).toBe('true');

        await user.click(await screen.findByRole('button', { name: 'Suggest an event' }));
        expect(onSuggest).toHaveBeenCalledOnce();
    });

    it('asks for confirmation when the result card is selected', async () => {
        server.use(
            http.get('*/api/events/search', () => HttpResponse.json([{
                event_id: 'evt-upcoming',
                title: 'Madrid Salsa Social',
                start: '2026-09-05T20:00:00Z',
                location: 'Madrid, Spain',
                city: 'Madrid',
                country: 'Spain',
                matched_fields: ['title'],
                matched_tags: [],
            }])),
        );
        const { user } = renderWithProviders(
            <FeatureFlagsProvider>
                <MyEventsAddSearch tab="upcoming" onSuggest={vi.fn()} />
            </FeatureFlagsProvider>,
        );

        await user.type(screen.getByRole('textbox', { name: 'Search events to add' }), 'madrid');
        await user.click(await screen.findByRole('button', { name: /Madrid Salsa Social/ }));

        expect(screen.getByRole('dialog', { name: 'Mark going?' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Mark going' })).toBeInTheDocument();
    });
});
