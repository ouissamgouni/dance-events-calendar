import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../types';
import TrendingEventsBanner from './TrendingEventsBanner';

vi.mock('./EventCard', () => ({
    default: ({ event }: { event: CalendarEvent }) => <div data-testid="event-card">{event.title}</div>,
}));
vi.mock('../hooks/useScrollDots', () => ({
    useScrollDots: () => ({ dotCount: 0, activeIndex: 0, scrollToIndex: () => { } }),
}));

const makeEvents = (): CalendarEvent[] => [
    {
        event_id: 'e1',
        calendar_id: 'cal',
        title: 'Hot event',
        description: null,
        location: null,
        latitude: null,
        longitude: null,
        start: new Date(2030, 0, 1, 20).toISOString(),
        end: new Date(2030, 0, 1, 23).toISOString(),
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: false,
        links: null,
        tags: [],
        popularity_score: 50,
    },
];

const renderBanner = (defaultCollapsed?: boolean) =>
    render(
        <TrendingEventsBanner
            events={makeEvents()}
            onEventClick={() => { }}
            showPopularity
            popularityThreshold={10}
            trendingTopN={3}
            trendingTopPercent={100}
            defaultCollapsed={defaultCollapsed}
        />,
    );

describe('TrendingEventsBanner', () => {
    it('is expanded by default', () => {
        renderBanner();
        expect(screen.getByTestId('trending-events-banner')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Trending/ }).getAttribute('aria-expanded')).toBe('true');
    });

    it('starts collapsed when defaultCollapsed is set and can still be expanded', () => {
        renderBanner(true);
        expect(screen.queryByTestId('trending-events-banner')).toBeNull();

        const toggle = screen.getByRole('button', { name: /Trending/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        fireEvent.click(toggle);
        expect(screen.getByTestId('trending-events-banner')).toBeTruthy();
    });
});
