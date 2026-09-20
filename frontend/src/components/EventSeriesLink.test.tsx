import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEventSeriesRollup } from '../api';
import EventSeriesLink from './EventSeriesLink';

vi.mock('../api', () => ({
    fetchEventSeriesRollup: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
    useAuth: () => ({ user: { user_id: 'user-1' } }),
}));

describe('EventSeriesLink details card', () => {
    beforeEach(() => {
        vi.mocked(fetchEventSeriesRollup).mockResolvedValue({
            series_id: 42,
            canonical_title: 'Magic Slovenian Salsa Festival',
            edition_count: 4,
            reviewed_edition_count: 0,
            total_review_count: 0,
            average_mood: 0,
            positive_percentage: 0,
            mood_label: null,
            display_state: 'none',
            sentiment_distribution: {},
            aspects: [],
            top_positive_tags: [],
            top_neutral_tags: [],
            top_negative_tags: [],
            top_audience_tags: [],
            editions: [],
        });
    });

    it('renders the whole series card as a route link with edition metadata', async () => {
        render(
            <MemoryRouter>
                <EventSeriesLink eventId="event-1" variant="details" />
            </MemoryRouter>,
        );

        const link = await screen.findByRole('link', { name: 'Open series Magic Slovenian Salsa Festival' });
        expect(fetchEventSeriesRollup).toHaveBeenCalledWith('event-1');
        expect(link).toHaveAttribute('href', '/series/42');
        expect(link).toHaveTextContent('Event series');
        expect(link).toHaveTextContent('Magic Slovenian Salsa Festival');
        expect(link).toHaveTextContent('Part of a 4-event series');
        expect(link).toHaveClass('rounded-card', 'bg-surface');
    });
});
