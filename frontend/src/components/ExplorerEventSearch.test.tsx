import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchEvents } from '../api';
import ExplorerEventSearch from './ExplorerEventSearch';

vi.mock('../api', () => ({
    searchEvents: vi.fn(),
}));

vi.mock('../context/AttendingEventsContext', () => ({
    useAttendingEvents: () => ({ isAttending: () => false }),
}));

vi.mock('./EventListPanel', () => ({
    EventListCard: ({ event, onEventClick }: { event: { title: string }; onEventClick: () => void }) => (
        <button type="button" onClick={onEventClick}>{event.title}</button>
    ),
}));

describe('ExplorerEventSearch', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('explains and selects a place and tag match', async () => {
        vi.useFakeTimers();
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
        expect(input).toHaveAttribute('placeholder', 'Search by event, place, or tag');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'paris pool' } });
        await act(async () => vi.advanceTimersByTimeAsync(251));

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
        const input = screen.getByRole('textbox', { name: 'Search by event, place, or tag' });
        expect(input.closest('[style]')).toHaveStyle({
            top: 'calc(64px + env(safe-area-inset-top) + 6px)',
        });
    });
});
