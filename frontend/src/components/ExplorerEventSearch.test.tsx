import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEventsByIds, searchEvents } from '../api';
import ExplorerEventSearch from './ExplorerEventSearch';

vi.mock('../api', () => ({
    fetchEventsByIds: vi.fn(),
    searchEvents: vi.fn(),
}));

vi.mock('../context/AttendingEventsContext', () => ({
    useAttendingEvents: () => ({ isAttending: () => false }),
}));

vi.mock('./SearchEventCard', () => ({
    default: ({ result, onOpen }: { result: { title: string }; onOpen: () => void }) => (
        <button type="button" onClick={onOpen}>{result.title}</button>
    ),
}));

describe('ExplorerEventSearch', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('explains and selects a place and tag match', async () => {
        vi.useFakeTimers();
        vi.mocked(fetchEventsByIds).mockResolvedValue([]);
        vi.mocked(searchEvents).mockResolvedValue([
            {
                event_id: 'evt-pool',
                title: 'Summer Social',
                start: '2026-09-01T20:00:00',
                location: 'Aquatic Centre',
                city: 'Paris',
                country: 'France',
                matched_fields: ['city', 'tag'],
                matched_tags: ['Pool'],
            },
        ]);
        const onSelectEvent = vi.fn();

        render(
            <MemoryRouter>
                <ExplorerEventSearch onSelectEvent={onSelectEvent} headerInline />
            </MemoryRouter>,
        );

        const input = screen.getByRole('textbox', { name: 'Search events' });
        expect(input).toHaveAttribute('placeholder', 'Search events, places, or tags…');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'paris pool' } });
        await act(async () => vi.advanceTimersByTimeAsync(251));
        expect(searchEvents).toHaveBeenCalledWith('paris pool', {
            limit: 25,
            dateScope: 'upcoming',
            excludeAttended: false,
        });

        fireEvent.click(screen.getByRole('button', { name: 'Summer Social' }));
        expect(onSelectEvent).toHaveBeenCalledWith('evt-pool');
    });

    it('positions the compact panel below the safe-area-aware header', () => {
        render(
            <MemoryRouter>
                <ExplorerEventSearch onSelectEvent={vi.fn()} compact />
            </MemoryRouter>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Search events' }));
        const input = screen.getByRole('textbox', { name: 'Search events, places, or tags' });
        expect(input.closest('[style]')).toHaveStyle({
            top: 'calc(64px + env(safe-area-inset-top) + 6px)',
        });
    });

    it('opens an overlay under the app header and closes it with Back', () => {
        render(
            <MemoryRouter>
                <ExplorerEventSearch onSelectEvent={vi.fn()} small overlay triggerLabel="Add event" />
            </MemoryRouter>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
        const overlay = screen.getByRole('dialog', { name: 'Add event' });
        expect(overlay).toHaveClass('fixed', 'top-[calc(64px+env(safe-area-inset-top))]');
        expect(screen.getByRole('textbox', { name: 'Search events, places, or tags' })).toHaveFocus();

        fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
        expect(screen.queryByRole('dialog', { name: 'Add event' })).not.toBeInTheDocument();
    });

    it('opts past events into broad search without excluding attended events', async () => {
        vi.useFakeTimers();
        vi.mocked(fetchEventsByIds).mockResolvedValue([]);
        vi.mocked(searchEvents).mockResolvedValue([]);

        render(
            <MemoryRouter>
                <ExplorerEventSearch onSelectEvent={vi.fn()} compact pastToggle />
            </MemoryRouter>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Search events' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Include past' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Search events, places, or tags' }), { target: { value: 'havana' } });
        await act(async () => vi.advanceTimersByTimeAsync(251));

        expect(searchEvents).toHaveBeenCalledWith('havana', {
            limit: 25,
            dateScope: 'all',
            excludeAttended: false,
        });
    });
});
