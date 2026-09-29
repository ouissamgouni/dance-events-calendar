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
        expect(grid.scrollLeft).toBe(0);

        grid.scrollTop = 5;
        grid.scrollLeft = 100;
        rerender(<ScheduleGrid schedule={{ ...schedule }} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} positionRequest={1} />);
        expect(grid.scrollTop).toBe(5);
        expect(grid.scrollLeft).toBe(100);

        rerender(<ScheduleGrid schedule={{ ...schedule }} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} positionRequest={2} />);
        expect(grid.scrollTop).toBeGreaterThan(5);
        expect(grid.scrollLeft).toBe(0);
    });

    it('shows structured contributors in assignment order', () => {
        render(<ScheduleGrid schedule={{
            ...schedule,
            contributors: [
                { id: 1, external_id: 'alexis-ruiz', display_name: 'Alexis Ruiz', sort_order: 0 },
                { id: 2, external_id: 'angelo-rito', display_name: 'Angelo Rito', sort_order: 1 },
                { id: 3, external_id: 'terry-salsalianza', display_name: 'Terry Salsalianza', sort_order: 2 },
            ],
            sessions: [{
                ...schedule.sessions[0],
                instructors: null,
                contributors: [
                    { contributor_id: 1, role: 'instructor', position: 0 },
                    { contributor_id: 2, role: 'instructor', position: 1 },
                    { contributor_id: 3, role: 'instructor', position: 2 },
                ],
            }],
        }} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} />);

        expect(screen.getByText('Alexis Ruiz, Angelo Rito, Terry Salsalianza')).toBeInTheDocument();
    });

    it('shows the full level label without an activity type', () => {
        render(<ScheduleGrid schedule={{
            ...schedule,
            levels: [{ id: 1, label: 'Advanced', notation: '**', sort_order: 0 }],
            activity_types: [{ id: 2, name: 'Workshop', color: 'blue', sort_order: 0 }],
            sessions: [{ ...schedule.sessions[0], level_id: 1, activity_type_id: 2 }],
        }} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} />);

        expect(screen.getByText('Advanced')).toBeInTheDocument();
        expect(screen.queryByText('**')).not.toBeInTheDocument();
        expect(screen.queryByText('Workshop')).not.toBeInTheDocument();
    });

    it('falls back to the level label when notation is unavailable', () => {
        render(<ScheduleGrid schedule={{
            ...schedule,
            levels: [{ id: 1, label: 'Open level', notation: null, sort_order: 0 }],
            sessions: [{ ...schedule.sessions[0], level_id: 1 }],
        }} day="2026-10-16" onSessionClick={vi.fn()} onTimeClick={vi.fn()} />);

        expect(screen.getByText('Open level')).toBeInTheDocument();
    });

    it('shows at most three attendee avatars and an overflow count', () => {
        render(
            <ScheduleGrid
                schedule={schedule}
                day="2026-10-16"
                onSessionClick={vi.fn()}
                onTimeClick={vi.fn()}
                attendeeSummaries={new Map([['afterparty', {
                    session_id: 'afterparty',
                    visible_count: 4,
                    preview_attendees: [
                        { user_id: '1', display_name: 'Alice', avatar_url: null, handle: 'alice' },
                        { user_id: '2', display_name: 'Bea', avatar_url: null, handle: 'bea' },
                        { user_id: '3', display_name: 'Cam', avatar_url: null, handle: 'cam' },
                        { user_id: '4', display_name: 'Dani', avatar_url: null, handle: 'dani' },
                    ],
                }]])}
            />,
        );

        const preview = screen.getByLabelText('4 people in their plan');
        expect(preview).toHaveTextContent('A');
        expect(preview).toHaveTextContent('B');
        expect(preview).toHaveTextContent('C');
        expect(preview).not.toHaveTextContent('D');
        expect(preview).toHaveTextContent('+1');
    });
});
