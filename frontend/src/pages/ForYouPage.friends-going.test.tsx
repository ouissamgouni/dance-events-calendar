import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { LensTrail, timeOfDayGreeting } from './ForYouPage';
import { renderWithProviders } from '../test/render';

describe('timeOfDayGreeting', () => {
    it.each([
        [0, 'Good morning'],
        [11, 'Good morning'],
        [12, 'Good afternoon'],
        [17, 'Good afternoon'],
        [18, 'Good evening'],
        [23, 'Good evening'],
    ])('returns the greeting for hour %i', (hour, expected) => {
        expect(timeOfDayGreeting(hour)).toBe(expected);
    });
});

describe('LensTrail friends-going pagination', () => {
    it('renders the shared scroll dots for the friends-going trail', () => {
        const events = Array.from({ length: 6 }, (_, index) => ({
            event_id: `evt-${index}`,
            title: `Event ${index}`,
            start: '2026-08-26T19:00:00Z',
            end: '2026-08-26T22:00:00Z',
            location: 'Berlin',
            image_url: null,
            popularity_score: 10,
            friends_going_preview: [],
            friends_going_count: 0,
        })) as any;

        renderWithProviders(
            <LensTrail
                title="Friends are going"
                events={events}
                hasMore={false}
                loading={false}
                onLoadMore={vi.fn()}
                onEventClick={vi.fn()}
                hoveredEventId={null}
                onEventHover={vi.fn()}
                trendingEnabled={false}
                popularityThreshold={0}
                trendingTopN={0}
                trendingTopPercent={0}
                newEventIds={new Set()}
                unseenStateEnabled={false}
                followingBadgeEnabled={false}
                contextLabel="friends going event"
                testId="friends-going-trail"
                cardVariant="friends-going"
            />,
        );

        expect(screen.getByRole('tablist', { name: 'Friends are going scroll position' })).toBeInTheDocument();
        const dots = screen.getAllByRole('tab');
        expect(dots.length).toBeGreaterThan(1);
    });

    it('scrolls the rail to the selected page when a dot is clicked', () => {
        const events = Array.from({ length: 9 }, (_, index) => ({
            event_id: `evt-${index}`,
            title: `Event ${index}`,
            start: '2026-08-26T19:00:00Z',
            end: '2026-08-26T22:00:00Z',
            location: 'Berlin',
            image_url: null,
            popularity_score: 10,
            friends_going_preview: [],
            friends_going_count: 0,
        })) as any;

        renderWithProviders(
            <LensTrail
                title="Friends are going"
                events={events}
                hasMore={false}
                loading={false}
                onLoadMore={vi.fn()}
                onEventClick={vi.fn()}
                hoveredEventId={null}
                onEventHover={vi.fn()}
                trendingEnabled={false}
                popularityThreshold={0}
                trendingTopN={0}
                trendingTopPercent={0}
                newEventIds={new Set()}
                unseenStateEnabled={false}
                followingBadgeEnabled={false}
                contextLabel="friends going event"
                testId="friends-going-trail"
                cardVariant="friends-going"
            />,
        );

        const scroller = screen.getByLabelText('Friends are going');
        Object.defineProperty(scroller, 'clientWidth', { value: 200, configurable: true });
        Object.defineProperty(scroller, 'scrollWidth', { value: 600, configurable: true });
        Object.defineProperty(scroller, 'scrollLeft', { value: 0, configurable: true });
        const scrollTo = vi.fn();
        Object.defineProperty(scroller, 'scrollTo', { value: scrollTo, configurable: true });

        fireEvent.click(screen.getByLabelText('Go to page 2 of 3'));
        expect(scrollTo).toHaveBeenCalledWith({ left: 200, behavior: 'smooth' });
    });
});
