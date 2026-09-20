import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { CalendarEvent } from '../types';
import { renderWithProviders } from '../test/render';
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext';
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

        expect(screen.getByRole('button', { name: /share|copy link/i })).toBeInTheDocument();
    });

    it('moves Share into More for past events', async () => {
        const { user } = renderActionBar(renderActions(true));

        expect(screen.queryByRole('button', { name: /share|copy link/i })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'More actions' }));
        expect(screen.getByRole('button', { name: /share|copy link/i })).toBeInTheDocument();
    });
});

describe('event action bar layout', () => {
    it('keeps modal actions on one row with a fixed trailing More control', () => {
        const { container } = renderActionBar(
            <EventActions {...commonProps} isPast={false} canReviewInline={false} />,
        );

        expect(container.firstElementChild).toHaveClass('flex-nowrap', 'gap-1');
        expect(screen.getByText('Save')).toHaveClass('hidden', 'min-[375px]:inline');
        const moreButton = screen.getByRole('button', { name: 'More actions' });
        expect(moreButton).toHaveClass('w-9');
        expect(moreButton.parentElement).toHaveClass('ml-auto', 'shrink-0');
    });

    it('uses the stronger surface and two-row desktop grid for the page dock', () => {
        const { container } = renderActionBar(<EventActionDock {...commonProps} isPast={false} />);

        expect(container.firstElementChild).toHaveClass('bg-action-tile');
        expect(container.firstElementChild?.firstElementChild).toHaveClass('flex-nowrap', 'lg:grid', 'lg:grid-cols-2');
        expect(screen.getByRole('button', { name: 'More actions' }).parentElement).toHaveClass('lg:col-start-2');
    });
});
