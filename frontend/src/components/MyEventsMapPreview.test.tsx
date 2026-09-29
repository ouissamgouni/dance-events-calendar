import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { defaultFlags, FeatureFlagsContext, FeatureFlagsProvider } from '../context/FeatureFlagsContext';
import { renderWithProviders } from '../test/render';
import { makeUser } from '../test/handlers';
import { server } from '../test/server';
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
        const onOpen = vi.fn();
        renderWithProviders(
            <FeatureFlagsProvider>
                <MyEventsMapPreview
                    event={event}
                    sequence={2}
                    hasPrevious
                    hasNext
                    onPrevious={onPrevious}
                    onNext={onNext}
                    onOpen={onOpen}
                />
            </FeatureFlagsProvider>,
        );

        const preview = screen.getByTestId('my-events-map-preview');
        fireEvent.pointerDown(preview, { clientX: 120 });
        fireEvent.pointerUp(preview, { clientX: 60 });
        fireEvent.keyDown(preview, { key: 'ArrowLeft' });
        fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
        fireEvent.click(screen.getByRole('button', { name: 'Open Paris Social' }));

        expect(onNext).toHaveBeenCalledTimes(2);
        expect(onPrevious).toHaveBeenCalledOnce();
        expect(onOpen).toHaveBeenCalledOnce();
        expect(screen.queryByTestId('attendee-avatar-stack')).not.toBeInTheDocument();
        expect(screen.getByTestId('event-date-sequence')).toHaveTextContent('2');
        expect(screen.getByTestId('my-events-map-card')).not.toHaveClass('border');
        expect(screen.queryByTestId('my-events-preview-image')).not.toBeInTheDocument();
    });

    it('shows only the compact event details and disables boundary navigation', () => {
        renderWithProviders(
            <FeatureFlagsProvider>
                <MyEventsMapPreview
                    event={event}
                    sequence={1}
                    hasPrevious={false}
                    hasNext={false}
                    onPrevious={vi.fn()}
                    onNext={vi.fn()}
                    onOpen={vi.fn()}
                />
            </FeatureFlagsProvider>,
        );

        expect(screen.queryByTestId('my-events-preview-image')).not.toBeInTheDocument();
        expect(screen.getByText('Paris Social')).toBeInTheDocument();
        expect(screen.getByTestId('event-date-sequence')).toHaveTextContent('1');
        expect(screen.getByTestId('event-date-sequence')).not.toHaveTextContent('#1');
        expect(screen.getByText('Paris, France')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Previous event' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Next event' })).toBeDisabled();
    });

    it('shows My Plan in an Upcoming map preview when the shared count is positive', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.post('*/api/my-plan/counts', () => HttpResponse.json([
                { event_id: 'evt-1', plan_count: 2 },
            ])),
        );
        renderWithProviders(
            <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, eventScheduleEnabled: true }, updateFlag: vi.fn() }}>
                <MyEventsMapPreview
                    event={{ ...event, schedule_published: true }}
                    hasPrevious={false}
                    hasNext={false}
                    onPrevious={vi.fn()}
                    onNext={vi.fn()}
                    onOpen={vi.fn()}
                    showProgramAction
                />
            </FeatureFlagsContext.Provider>,
        );

        expect(await screen.findByRole('link', { name: 'My Plan' })).toHaveAttribute('href', '/event/evt-1/program/plan');
    });
});
