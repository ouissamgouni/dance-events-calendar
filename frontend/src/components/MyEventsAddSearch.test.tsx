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
            http.post('*/api/events/by-ids', () => HttpResponse.json([{
                event_id: 'evt-upcoming',
                calendar_id: 'calendar-1',
                title: 'Madrid Salsa Social',
                description: null,
                location: 'Madrid, Spain',
                latitude: null,
                longitude: null,
                start: '2026-09-05T20:00:00Z',
                end: '2026-09-06T01:00:00Z',
                all_day: false,
                color: null,
                view_count: 0,
                price_min: null,
                price_max: null,
                price_currency: null,
                price_is_free: false,
                links: null,
                tags: [],
            }])),
        );
        const { user } = renderWithProviders(
            <FeatureFlagsProvider>
                <MyEventsAddSearch tab="upcoming" onSuggest={vi.fn()} />
            </FeatureFlagsProvider>,
        );

        await user.type(screen.getByRole('textbox', { name: 'Search events to add' }), 'madrid');
        const result = await screen.findByTestId('explorer-event-search-result-0');
        expect(result).toHaveTextContent('Madrid Salsa Social');
        expect(result.querySelector('[data-testid="card-actions"]')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Open Madrid Salsa Social' }));

        expect(screen.getByRole('dialog', { name: 'Mark going?' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Mark going' })).toBeInTheDocument();
    });
});
