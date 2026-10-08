import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../types';
import EventListPanel from './EventListPanel';

const authState = vi.hoisted(() => ({ user: null as { id: string } | null }));
const layoutFlags = vi.hoisted(() => ({ explorerCardTitleTopEnabled: false, explorerCardSaveBottomEnabled: false }));

vi.mock('../context/FeatureFlagsContext', () => ({
    useFeatureFlags: () => ({
        explorerListPageSize: 5,
        explorerEventCardCardStyleEnabled: true,
        tagsPerCard: 3,
        trendingTopN: 3,
        trendingTopPercent: 100,
        ...layoutFlags,
    }),
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../context/SavedEventsContext', () => ({ useSavedEvents: () => ({ isSaved: () => false }) }));
vi.mock('../hooks/useEventCardImage', () => ({ useEventCardImage: () => ({ node: null }) }));
vi.mock('./EventCard', () => ({
    default: ({ event, titleTop, saveBottom }: { event: CalendarEvent; titleTop?: boolean; saveBottom?: boolean }) => (
        <div data-testid="event-card" data-title-top={String(titleTop)} data-save-bottom={String(saveBottom)}>{event.title}</div>
    ),
}));

const makeEvents = (n: number): CalendarEvent[] =>
    Array.from({ length: n }, (_, i) => ({
        event_id: `e${i}`,
        calendar_id: 'cal',
        title: `Event ${i}`,
        description: null,
        location: null,
        latitude: null,
        longitude: null,
        start: new Date(2030, 0, i + 1, 20).toISOString(),
        end: new Date(2030, 0, i + 1, 23).toISOString(),
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: false,
        links: null,
        tags: [],
    }));

const renderPanel = (gate = false) =>
    render(
        <MemoryRouter>
            <EventListPanel
                events={makeEvents(12)}
                mapBounds={null}
                onEventClick={() => { }}
                showPrices={false}
                showPopularity={false}
                sortBy="date"
                onSortChange={() => { }}
                gateMoreEventsForAnonymous={gate}
            />
        </MemoryRouter>,
    );

describe('EventListPanel page size', () => {
    it('uses the configured page size for initial count and show more', () => {
        authState.user = { id: 'u1' };
        renderPanel();
        expect(screen.getAllByTestId('event-card')).toHaveLength(5);
        fireEvent.click(screen.getByTestId('event-list-show-more'));
        expect(screen.getAllByTestId('event-card')).toHaveLength(10);
        expect(screen.getByTestId('event-list-show-more')).toHaveTextContent('+ 2 more');
    });

    it('gates anonymous viewers after the configured page size', () => {
        authState.user = null;
        renderPanel(true);
        expect(screen.getAllByTestId('event-card')).toHaveLength(5);
        expect(screen.getByTestId('event-list-more-events-gate')).toBeInTheDocument();
    });
});

describe('EventListPanel card layout flags', () => {
    it('passes the title-top and save-bottom flags to the card', () => {
        authState.user = { id: 'u1' };
        layoutFlags.explorerCardTitleTopEnabled = true;
        layoutFlags.explorerCardSaveBottomEnabled = true;
        try {
            renderPanel();
            const card = screen.getAllByTestId('event-card')[0];
            expect(card).toHaveAttribute('data-title-top', 'true');
            expect(card).toHaveAttribute('data-save-bottom', 'true');
        } finally {
            layoutFlags.explorerCardTitleTopEnabled = false;
            layoutFlags.explorerCardSaveBottomEnabled = false;
        }
    });
});

describe('EventListPanel scrollResetKey', () => {
    it('scrolls the list back to top when the key changes', () => {
        authState.user = { id: 'u1' };
        const props = {
            events: makeEvents(3),
            mapBounds: null,
            onEventClick: () => { },
            showPrices: false,
            showPopularity: false,
            sortBy: 'date' as const,
            onSortChange: () => { },
        };
        const { container, rerender } = render(
            <MemoryRouter><EventListPanel {...props} scrollResetKey="a" /></MemoryRouter>,
        );
        const scroller = container.querySelector('.event-list-scroll') as HTMLDivElement;
        scroller.scrollTop = 200;
        rerender(<MemoryRouter><EventListPanel {...props} scrollResetKey="a" /></MemoryRouter>);
        expect(scroller.scrollTop).toBe(200);
        rerender(<MemoryRouter><EventListPanel {...props} scrollResetKey="b" /></MemoryRouter>);
        expect(scroller.scrollTop).toBe(0);
    });
});
