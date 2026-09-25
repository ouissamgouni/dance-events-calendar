import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventSchedule } from '../../types';
import ScheduleGrid from './ScheduleGrid';

const schedule: EventSchedule = {
    event_id: 'movida-2026',
    timezone: 'Europe/Prague',
    day_start_hour: 6,
    days: ['2026-10-15', '2026-10-16'],
    venues: [],
    rooms: [],
    levels: [],
    activity_types: [],
    sessions: [{ id: 'afterparty', title: 'Late Night Afterparty', instructors: null, start: '2026-10-17T00:00:00Z', end: '2026-10-17T01:00:00Z', room_id: null, venue_id: null, level_id: null, activity_type_id: null, attendee_note: null, allow_plan: true, is_cancelled: false }],
    version: 1,
    published_at: '2026-09-01T12:00:00Z',
};

describe('ScheduleGrid', () => {
    afterEach(() => vi.useRealTimers());

    it('shows the current-time marker on the previous program day before cutoff', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-17T00:30:00Z'));

        render(<ScheduleGrid schedule={schedule} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} />);

        expect(screen.getByLabelText('Current time 02:30')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Late Night Afterparty.*Now/ })).toHaveAttribute('aria-current', 'time');
    });

    it('positions the first available session once for each user action request', () => {
        const { rerender } = render(<ScheduleGrid schedule={schedule} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} positionRequest={1} />);
        const grid = screen.getByTestId('schedule-grid');
        expect(grid.scrollTop).toBeGreaterThan(0);

        grid.scrollTop = 5;
        rerender(<ScheduleGrid schedule={{ ...schedule }} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} positionRequest={1} />);
        expect(grid.scrollTop).toBe(5);

        rerender(<ScheduleGrid schedule={{ ...schedule }} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} positionRequest={2} />);
        expect(grid.scrollTop).toBeGreaterThan(5);
    });
});
