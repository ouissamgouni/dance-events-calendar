import { useEffect, useRef, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEventsByIds } from '../api';
import type { CalendarEvent } from '../types';
import MyEventsExperience from './MyEventsExperience';

vi.mock('../api', () => ({
    fetchEventsByIds: vi.fn(),
}));

vi.mock('../context/SavedEventsContext', () => ({
    useSavedEvents: () => ({
        savedEventIds: ['mapped', 'outside', 'unmapped'],
        isSaved: () => true,
    }),
}));

vi.mock('../context/AttendingEventsContext', () => ({
    useAttendingEvents: () => ({
        attendingEventIds: ['mapped', 'outside', 'unmapped'],
        isAttending: () => true,
        loading: false,
    }),
}));

const featureFlags = vi.hoisted(() => ({ myEventsRouteEnabled: true }));
vi.mock('../context/FeatureFlagsContext', () => ({
    useFeatureFlags: () => featureFlags,
}));

vi.mock('../components/CalendarMapWorkspace', () => ({
    default: ({ map, onDatesChange }: { map?: () => ReactNode; onDatesChange?: (start: Date, end: Date) => void }) => {
        const initialDatesChange = useRef(onDatesChange);
        useEffect(() => {
            initialDatesChange.current?.(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-22T00:00:00Z'));
        }, []);
        return <div data-testid="calendar-workspace" data-has-map={String(Boolean(map))}>{map?.()}</div>;
    },
}));

vi.mock('../components/EventMap', () => ({
    default: ({ events, cooperativeGestures, fitMarkersControl, journeyRouteOn, onJourneyRouteToggle }: {
        events: CalendarEvent[];
        cooperativeGestures?: boolean;
        fitMarkersControl?: boolean;
        journeyRouteOn?: boolean;
        onJourneyRouteToggle?: () => void;
    }) => (
        <div>
            <div
                data-testid="event-map"
                data-event-ids={events.map((event) => event.event_id).join(',')}
                data-cooperative-gestures={String(Boolean(cooperativeGestures))}
                data-fit-markers={String(Boolean(fitMarkersControl))}
                data-route-on={String(Boolean(journeyRouteOn))}
            />
            {onJourneyRouteToggle && (
                <button
                    type="button"
                    aria-label={journeyRouteOn ? 'Hide route' : 'Show route'}
                    aria-pressed={journeyRouteOn}
                    onClick={onJourneyRouteToggle}
                />
            )}
        </div>
    ),
}));

vi.mock('../components/MyEventsList', () => ({ default: () => <div data-testid="events-list" /> }));
vi.mock('../components/MyEventsMapPreview', () => ({ default: () => <div data-testid="map-preview" /> }));
vi.mock('../components/MyEventsAddSearch', () => ({ default: () => <div /> }));
vi.mock('../components/EventModal', () => ({ default: () => <div /> }));
vi.mock('../components/SuggestEventModal', () => ({ default: () => <div /> }));

function event(eventId: string, located: boolean, start = '2026-09-05T20:00:00Z'): CalendarEvent {
    return {
        event_id: eventId,
        calendar_id: 'calendar',
        title: eventId,
        description: null,
        image_url: null,
        location: 'Paris, France',
        city: 'Paris',
        country: 'France',
        latitude: located ? 48.8 : null,
        longitude: located ? 2.3 : null,
        start,
        end: new Date(new Date(start).getTime() + 2 * 60 * 60 * 1000).toISOString(),
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
}

describe('MyEventsExperience view modes', () => {
    beforeEach(() => {
        vi.stubGlobal('scrollTo', vi.fn());
        vi.mocked(fetchEventsByIds).mockResolvedValue([
            event('mapped', true),
            event('outside', true, '2026-10-05T20:00:00Z'),
            event('unmapped', false),
        ]);
    });

    it('renders a cooperative Calendar map scoped to the visible range', async () => {
        const user = userEvent.setup();
        render(<MyEventsExperience />);

        await waitFor(() => expect(screen.getByTestId('events-list')).toBeInTheDocument());
        await user.click(screen.getByRole('button', { name: 'Calendar view' }));

        await waitFor(() => expect(screen.getByTestId('calendar-workspace')).toHaveAttribute('data-has-map', 'true'));
        expect(screen.getByTestId('event-map')).toHaveAttribute('data-event-ids', 'mapped');
        expect(screen.getByTestId('event-map')).toHaveAttribute('data-cooperative-gestures', 'true');
    });

    it('renders a standalone map with default one-finger gestures', async () => {
        const user = userEvent.setup();
        render(<MyEventsExperience />);

        await waitFor(() => expect(screen.getByTestId('events-list')).toBeInTheDocument());
        await user.click(screen.getByRole('button', { name: 'Map view' }));

        expect(screen.getByTestId('event-map')).toHaveAttribute('data-event-ids', 'mapped,outside');
        expect(screen.getByTestId('event-map')).toHaveAttribute('data-cooperative-gestures', 'false');
        expect(screen.getByTestId('event-map')).toHaveAttribute('data-fit-markers', 'true');
        expect(screen.getByTestId('event-map')).toHaveAttribute('data-route-on', 'true');
        const route = screen.getByRole('button', { name: 'Hide route' });
        expect(route).toHaveAttribute('aria-pressed', 'true');
        await user.click(route);
        expect(screen.getByTestId('event-map')).toHaveAttribute('data-route-on', 'false');
        expect(screen.getByRole('button', { name: 'Show route' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByTestId('map-preview')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '1 without map location · List' })).toBeInTheDocument();

        await user.click(screen.getByRole('tab', { name: 'Saved' }));
        await user.click(screen.getByRole('button', { name: 'Map view' }));
        expect(screen.getByTestId('event-map')).toHaveAttribute('data-route-on', 'false');
        expect(screen.getByRole('button', { name: 'Show route' })).toHaveAttribute('aria-pressed', 'false');
    });
});
