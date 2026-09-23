import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EventSearchResult } from '../api';
import type { CalendarEvent } from '../types';
import SearchEventCard from './SearchEventCard';

vi.mock('../context/FeatureFlagsContext', () => ({
    useOptionalFeatureFlags: () => ({ followingBadgeEnabled: true, showRatings: true }),
}));

vi.mock('./EventCard', () => ({
    default: ({ showActions, isPast, showPastLabel, onOpen }: { showActions: boolean; isPast: boolean; showPastLabel: boolean; onOpen: () => void }) => (
        <button type="button" onClick={onOpen} data-testid="event-card" data-actions={showActions} data-past={isPast} data-past-label={showPastLabel}>
            Hydrated event
        </button>
    ),
}));

const result: EventSearchResult = {
    event_id: 'event-1',
    title: 'Havana Rooftop Social',
    start: '2023-09-01T21:00:00Z',
    end: '2023-09-02T02:00:00Z',
    location: 'Rooftop Bar',
    city: 'Havana',
    country: 'Cuba',
    matched_fields: ['title'],
    matched_tags: [],
};

const event: CalendarEvent = {
    event_id: result.event_id,
    calendar_id: 'calendar-1',
    title: result.title,
    description: null,
    location: result.location,
    latitude: null,
    longitude: null,
    start: result.start!,
    end: '2023-09-02T02:00:00Z',
    all_day: false,
    color: null,
    view_count: 0,
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: false,
    links: null,
    tags: [],
};

describe('SearchEventCard', () => {
    it('keeps actions in browse mode and opens the hydrated card', () => {
        const onOpen = vi.fn();
        render(<SearchEventCard result={result} event={event} onOpen={onOpen} />);

        expect(screen.getByTestId('event-card')).toHaveAttribute('data-actions', 'true');
        fireEvent.click(screen.getByTestId('event-card'));
        expect(onOpen).toHaveBeenCalledOnce();
    });

    it('hides actions in selection mode and marks past events', () => {
        render(<SearchEventCard result={result} event={event} onOpen={vi.fn()} purpose="select" />);

        expect(screen.getByTestId('event-card')).toHaveAttribute('data-actions', 'false');
        expect(screen.getByTestId('event-card')).toHaveAttribute('data-past', 'true');
        expect(screen.getByTestId('event-card')).toHaveAttribute('data-past-label', 'false');
    });

    it('shows an explicit Past marker only when mixed results request it', () => {
        const { rerender } = render(<SearchEventCard result={result} onOpen={vi.fn()} />);
        expect(screen.queryByText('Past')).not.toBeInTheDocument();

        rerender(<SearchEventCard result={result} onOpen={vi.fn()} showPastLabel />);
        expect(screen.getByText('Past')).toBeInTheDocument();

        rerender(<SearchEventCard result={result} event={event} onOpen={vi.fn()} showPastLabel />);
        expect(screen.getByTestId('event-card')).toHaveAttribute('data-past-label', 'true');
    });

    it('renders a selectable sparse-result fallback when hydration fails', () => {
        const onOpen = vi.fn();
        render(<SearchEventCard result={result} onOpen={onOpen} highlighted />);

        const fallback = screen.getByRole('button', { name: 'Open Havana Rooftop Social' });
        expect(fallback).toHaveTextContent('Sep 1, 2023');
        expect(fallback).toHaveTextContent('Rooftop Bar, Havana, Cuba');
        expect(fallback).toHaveClass('border-action');
        fireEvent.click(fallback);
        expect(onOpen).toHaveBeenCalledOnce();
    });
});
