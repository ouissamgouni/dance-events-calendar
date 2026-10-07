import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { setTicketNotNeeded } from '../api';
import type { CalendarEvent } from '../types';
import TicketAction from './TicketAction';

const patch = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ value: { label: 'Add ticket', eventDay: false, inline: true } as { label: string; eventDay: boolean; inline: boolean } }));

vi.mock('../api', () => ({ setTicketNotNeeded: vi.fn() }));
vi.mock('../context/EventAssetSummaryContext', () => ({ usePatchEventAssetSummary: () => patch }));
vi.mock('../hooks/useTicketAction', () => ({ useTicketAction: () => state.value }));
vi.mock('./TicketSheet', () => ({ default: () => null }));

const event = { event_id: 'evt', title: 'Gala' } as CalendarEvent;

describe('TicketAction', () => {
    it('asks "Add ticket?" and dismisses it as not needed', () => {
        vi.mocked(setTicketNotNeeded).mockResolvedValue({} as Awaited<ReturnType<typeof setTicketNotNeeded>>);
        render(<TicketAction event={event} variant="full" dismissible />);

        expect(screen.getByRole('button', { name: 'Add ticket?' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss add ticket' }));

        expect(patch).toHaveBeenCalledWith('evt', { ticket_not_needed: true });
        expect(setTicketNotNeeded).toHaveBeenCalledWith('evt', true);
    });

    it('keeps the plain label without a dismiss when not dismissible or a ticket exists', () => {
        const { rerender } = render(<TicketAction event={event} variant="full" />);
        expect(screen.getByRole('button', { name: 'Add ticket' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Dismiss add ticket' })).not.toBeInTheDocument();

        state.value = { label: 'My ticket', eventDay: false, inline: true };
        rerender(<TicketAction event={event} variant="full" dismissible />);
        expect(screen.getByRole('button', { name: 'My ticket' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Dismiss add ticket' })).not.toBeInTheDocument();
    });
});
