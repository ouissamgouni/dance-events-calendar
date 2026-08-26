import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext';
import { renderWithProviders } from '../test/render';
import type { CalendarEvent } from '../types';
import MyEventsMapPreview from './MyEventsMapPreview';

const event: CalendarEvent = {
    event_id: 'evt-1',
    calendar_id: 'cal',
    title: 'Paris Social',
    description: null,
    image_url: '/broken.jpg',
    location: 'Paris, France',
    city: 'Paris',
    country: 'France',
    latitude: 48.8,
    longitude: 2.3,
    start: '2026-09-05T20:00:00Z',
    end: '2026-09-05T22:00:00Z',
    all_day: false,
    color: null,
    view_count: 0,
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: true,
    links: null,
    tags: [],
};

describe('MyEventsMapPreview', () => {
    it('swipes and uses arrow keys to move through chronology', () => {
        const onPrevious = vi.fn();
        const onNext = vi.fn();
        renderWithProviders(
            <FeatureFlagsProvider>
                <MyEventsMapPreview
                    event={event}
                    sequence={2}
                    tab="upcoming"
                    hasPrevious
                    hasNext
                    onPrevious={onPrevious}
                    onNext={onNext}
                    onOpen={vi.fn()}
                />
            </FeatureFlagsProvider>,
        );

        const preview = screen.getByTestId('my-events-map-preview');
        fireEvent.pointerDown(preview, { clientX: 120 });
        fireEvent.pointerUp(preview, { clientX: 60 });
        fireEvent.keyDown(preview, { key: 'ArrowLeft' });

        expect(onNext).toHaveBeenCalledOnce();
        expect(onPrevious).toHaveBeenCalledOnce();
    });

    it('collapses the optional image when loading fails', () => {
        renderWithProviders(
            <FeatureFlagsProvider>
                <MyEventsMapPreview
                    event={event}
                    sequence={1}
                    tab="upcoming"
                    hasPrevious={false}
                    hasNext={false}
                    onPrevious={vi.fn()}
                    onNext={vi.fn()}
                    onOpen={vi.fn()}
                />
            </FeatureFlagsProvider>,
        );

        fireEvent.error(screen.getByTestId('my-events-preview-image'));
        expect(screen.queryByTestId('my-events-preview-image')).not.toBeInTheDocument();
    });
});
