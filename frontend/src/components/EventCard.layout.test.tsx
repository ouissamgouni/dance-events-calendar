import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import EventCard from './EventCard';
import { FeatureFlagsContext, defaultFlags } from '../context/FeatureFlagsContext';
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
vi.mock('./CardActionCluster', () => ({
    default: ({ include }: { include: ReadonlyArray<string> }) => <span data-testid={`cluster-${include.join('-')}`} />,
}));

const event: CalendarEvent = {
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
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: false,
    links: null,
    tags: [],
};

function renderCard(props: { titleTop?: boolean; saveBottom?: boolean } = {}) {
    const flags = { ...defaultFlags, eventCardImgoingLocationBottomEnabled: true };
    return renderWithProviders(
        <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
            <EventCard
                event={event}
                onOpen={vi.fn()}
                showAvatars={false}
                showReviews={false}
                actionsTestId="top-actions"
                {...props}
            />
        </FeatureFlagsContext.Provider>,
    );
}

describe('EventCard explorer layout options', () => {
    it('keeps the title beside the image and Save top-right by default', () => {
        renderCard();
        const title = screen.getByRole('heading', { name: 'Salsa Social' });
        expect(screen.getByTestId('event-card-image-row')).toContainElement(title);
        expect(title).toHaveClass('pr-14');
        expect(screen.getByTestId('top-actions')).toHaveClass('absolute');
        expect(screen.getByTestId('cluster-save')).toBeInTheDocument();
        expect(screen.getByTestId('cluster-going')).toBeInTheDocument();
    });

    it('titleTop puts the title and Save in a row above the image', () => {
        renderCard({ titleTop: true });
        const title = screen.getByRole('heading', { name: 'Salsa Social' });
        expect(screen.getByTestId('event-card-image-row')).not.toContainElement(title);
        expect(title).not.toHaveClass('pr-14');
        const actions = screen.getByTestId('top-actions');
        expect(actions).not.toHaveClass('absolute');
        expect(actions.parentElement).toContainElement(title);
    });

    it('saveBottom moves Save next to Going in the bottom row', () => {
        renderCard({ saveBottom: true });
        expect(screen.queryByTestId('top-actions')).not.toBeInTheDocument();
        expect(screen.getByTestId('cluster-save-going')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Salsa Social' })).not.toHaveClass('pr-14');
    });
});
