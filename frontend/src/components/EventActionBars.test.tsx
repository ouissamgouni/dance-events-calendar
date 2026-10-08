import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { CalendarEvent } from '../types';
import { renderWithProviders } from '../test/render';
import { FeatureFlagsContext, FeatureFlagsProvider, defaultFlags } from '../context/FeatureFlagsContext';
import EventActionDock from './EventActionDock';
import EventActions from './event-summary/EventActions';

const EVENT = {
    event_id: 'evt-actions',
    title: 'Salsa Social',
} as CalendarEvent;

const commonProps = {
    event: EVENT,
    shareUrl: 'https://example.test/event/evt-actions',
    onPostMessage: vi.fn(),
};

function renderActionBar(element: React.ReactElement) {
    return renderWithProviders(<FeatureFlagsProvider>{element}</FeatureFlagsProvider>);
}

describe.each([
    ['modal actions', (isPast: boolean) => (
        <EventActions {...commonProps} isPast={isPast} canReviewInline={isPast} />
    )],
    ['page action dock', (isPast: boolean) => (
        <EventActionDock {...commonProps} isPast={isPast} />
    )],
] as const)('%s', (_name, renderActions) => {
    it('shows Share inline for upcoming events', () => {
        renderActionBar(renderActions(false));

        expect(screen.getAllByRole('button', { name: /^(share|copy link)$/i })[0]).toBeInTheDocument();
    });
});

describe('modal actions overflow', () => {
    it('moves Share into More for past events', async () => {
        const { user } = renderActionBar(<EventActions {...commonProps} isPast canReviewInline />);

        expect(screen.queryByRole('button', { name: /^(share|copy link)$/i })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'More actions' }));
        expect(screen.getByRole('button', { name: /^(share|copy link)$/i })).toBeInTheDocument();
    });
});

describe('page action dock overflow', () => {
    it('lists every secondary action on desktop and keeps More mobile-only', async () => {
        const { user } = renderActionBar(<EventActionDock {...commonProps} isPast />);

        const desktopShare = screen.getByRole('button', { name: /^(share|copy link)$/i });
        expect(desktopShare).toHaveClass('hidden', 'lg:flex');
        expect(screen.getByRole('button', { name: 'Start discussion' })).toHaveClass('hidden', 'lg:flex');
        expect(screen.getByRole('button', { name: 'More actions' }).parentElement).toHaveClass('lg:hidden');

        await user.click(screen.getByRole('button', { name: 'More actions' }));
        expect(screen.getAllByRole('button', { name: /^(share|copy link)$/i })).toHaveLength(2);
    });
});

describe('upcoming edition review', () => {
    const upcoming = { ...EVENT, start: '2099-01-01T20:00:00Z', end: '2099-01-02T01:00:00Z' } as CalendarEvent;
    const withRatings = (element: React.ReactElement) => renderWithProviders(
        <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, showRatings: true }, updateFlag: vi.fn() }}>
            {element}
        </FeatureFlagsContext.Provider>,
    );

    it('keeps the earlier-edition review behind More in modal actions', async () => {
        const { user } = withRatings(
            <EventActions {...commonProps} event={upcoming} isPast={false} canReviewInline={false} />,
        );

        expect(screen.queryByRole('button', { name: /earlier edition/i })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'More actions' }));
        expect(screen.getByRole('menu')).toContainElement(screen.getByRole('button', { name: /earlier edition/i }));
    });

    it('keeps the earlier-edition review in the mobile More menu of the dock', async () => {
        const { user } = withRatings(<EventActionDock {...commonProps} event={upcoming} isPast={false} />);

        await user.click(screen.getByRole('button', { name: 'More actions' }));
        const inMenu = screen.getAllByRole('button', { name: /earlier edition/i })
            .filter((el) => screen.getByRole('menu').contains(el));
        expect(inMenu).toHaveLength(1);
    });
});

describe('past event actions', () => {
    const past = { ...EVENT, start: '2020-01-01T20:00:00Z', end: '2020-01-02T01:00:00Z' } as CalendarEvent;
    const withRatings = (element: React.ReactElement) => renderWithProviders(
        <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, showRatings: true }, updateFlag: vi.fn() }}>
            {element}
        </FeatureFlagsContext.Provider>,
    );

    it.each([
        ['modal actions', <EventActions {...commonProps} event={past} isPast canReviewInline />],
        ['page action dock', <EventActionDock {...commonProps} event={past} isPast />],
    ])('%s: drops Save and offers an empty-star Review CTA', (_name, element) => {
        withRatings(element);

        expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
        const review = screen.getByRole('button', { name: 'Review this event' });
        expect(review).toHaveTextContent('Review');
        expect(review.querySelector('svg')).toHaveAttribute('fill', 'none');
    });
});

describe('organizer claim action', () => {
    const renderWithClaims = (event: CalendarEvent) => renderWithProviders(
        <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, organizerClaimsEnabled: true }, updateFlag: vi.fn() }}>
            <EventActions {...commonProps} event={event} isPast={false} canReviewInline={false} />
        </FeatureFlagsContext.Provider>,
    );

    it('offers "I organize this event" while the event has no organizer', async () => {
        const { user } = renderWithClaims(EVENT);

        await user.click(screen.getByRole('button', { name: 'More actions' }));
        expect(screen.getByRole('menuitem', { name: 'I organize this event' })).toBeInTheDocument();
    });

    it('hides it once the event has an organizer', async () => {
        const { user } = renderWithClaims({
            ...EVENT,
            organizer: { user_id: 'u2', handle: 'olive', display_name: 'Olive', avatar_url: null, is_verified_organizer: true },
        });

        await user.click(screen.getByRole('button', { name: 'More actions' }));
        expect(screen.queryByRole('menuitem', { name: 'I organize this event' })).toBeNull();
    });
});

describe('event action bar layout', () => {
    it('keeps modal actions on one row with a fixed trailing More control', () => {
        const { container } = renderActionBar(
            <EventActions {...commonProps} isPast={false} canReviewInline={false} />,
        );

        expect(container.firstElementChild).toHaveClass('min-w-0', 'flex-nowrap', 'gap-1');
        expect(screen.getByText('Save')).toHaveClass('hidden', 'min-[375px]:inline');
        const moreButton = screen.getByRole('button', { name: 'More actions' });
        expect(moreButton).toHaveClass('h-9', 'w-9');
        expect(moreButton.parentElement).toHaveClass('ml-auto', 'shrink-0');
    });

    it('uses a content-width light-blue vertical desktop stack for the page dock', () => {
        const { container } = renderActionBar(<EventActionDock {...commonProps} isPast={false} />);

        expect(container.firstElementChild).toHaveClass('bg-blue-50', 'lg:w-fit');
        expect(container.firstElementChild?.firstElementChild).toHaveClass('flex-nowrap', 'lg:w-max', 'lg:flex-col', 'lg:items-stretch');
        const moreButton = screen.getByRole('button', { name: 'More actions' });
        expect(moreButton.parentElement).toHaveClass('ml-auto', 'lg:hidden');
    });
});
