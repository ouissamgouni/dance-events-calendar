import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext';
import type { CalendarEvent } from '../types';
import ProgramAction from './ProgramAction';

const event = {
    event_id: 'program-event',
    title: 'Program Event',
    start: '2027-09-05T20:00:00Z',
    end: '2027-09-05T23:00:00Z',
    schedule_published: true,
} as CalendarEvent;

function renderAction(enabled: boolean, value: CalendarEvent = event, variant: 'full' | 'compact' = 'compact') {
    return render(
        <MemoryRouter>
            <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, eventScheduleEnabled: enabled }, updateFlag: vi.fn() }}>
                <ProgramAction event={value} variant={variant} />
            </FeatureFlagsContext.Provider>
        </MemoryRouter>,
    );
}

afterEach(() => vi.useRealTimers());

describe('ProgramAction', () => {
    it('links to a published program when the feature is enabled', () => {
        renderAction(true);

        expect(screen.getByRole('link', { name: 'Program' })).toHaveAttribute('href', '/event/program-event/program');
    });

    it('stays hidden when the feature or publication is unavailable', () => {
        const { rerender } = renderAction(false);
        expect(screen.queryByRole('link')).not.toBeInTheDocument();

        rerender(
            <MemoryRouter>
                <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, eventScheduleEnabled: true }, updateFlag: vi.fn() }}>
                    <ProgramAction event={{ ...event, schedule_published: false }} />
                </FeatureFlagsContext.Provider>
            </MemoryRouter>,
        );
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('uses live copy for an active event', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2027-09-05T21:00:00Z'));
        renderAction(true, event, 'full');

        expect(screen.getByRole('link', { name: 'Open live program' })).toBeInTheDocument();
    });
});
