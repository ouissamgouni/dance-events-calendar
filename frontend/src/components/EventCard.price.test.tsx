import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import EventCard from './EventCard';
import {
    FeatureFlagsContext,
    defaultFlags,
    type FeatureFlags,
} from '../context/FeatureFlagsContext';
import { renderWithProviders } from '../test/render';
import type { CalendarEvent } from '../types';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return {
        ...actual,
        fetchSettings: vi.fn(async () => {
            throw new Error('settings disabled in test');
        }),
    };
});

function withFlags(overrides: Partial<FeatureFlags>) {
    const flags = { ...defaultFlags, ...overrides };
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
                {children}
            </FeatureFlagsContext.Provider>
        );
    };
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        event_id: 'event-1',
        calendar_id: 'calendar-1',
        title: 'Salsa Social',
        description: null,
        location: null,
        latitude: null,
        longitude: null,
        start: '2026-10-01T20:00:00Z',
        end: '2026-10-01T23:00:00Z',
        all_day: false,
        color: null,
        view_count: 0,
        price_is_free: false,
        price_min: 120,
        price_max: null,
        price_currency: 'EUR',
        links: null,
        tags: [],
        ...overrides,
    };
}

function renderCard(
    source: CalendarEvent,
    showPrices: boolean,
    showPrice = true,
) {
    const Wrapper = withFlags({ showPrices });
    return renderWithProviders(
        <Wrapper>
            <EventCard
                event={source}
                onOpen={vi.fn()}
                showPrice={showPrice}
                showActions={false}
                showAvatars={false}
                showReviews={false}
            />
        </Wrapper>,
    );
}

describe('EventCard price visibility', () => {
    it('inherits the global Show prices flag for Auto visibility', () => {
        const { unmount } = renderCard(event(), true);
        expect(screen.getByText('€120+')).toBeInTheDocument();

        unmount();
        renderCard(event(), false);
        expect(screen.queryByText('€120+')).not.toBeInTheDocument();
    });

    it('honors explicit per-event Show and Hide overrides', () => {
        const { unmount } = renderCard(event({ show_price_override: true }), false);
        expect(screen.getByText('€120+')).toBeInTheDocument();

        unmount();
        renderCard(event({ show_price_override: false }), true);
        expect(screen.queryByText('€120+')).not.toBeInTheDocument();
    });

    it('keeps the component-level price suppression authoritative', () => {
        renderCard(event({ show_price_override: true }), true, false);

        expect(screen.queryByText('€120+')).not.toBeInTheDocument();
    });
});
