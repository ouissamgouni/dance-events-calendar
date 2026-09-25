import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEvent, fetchEventSchedule, fetchMyPlan } from '../api';
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext';
import type { CalendarEvent, EventSchedule } from '../types';
import EventProgramPage from './EventProgramPage';

const authState = vi.hoisted(() => ({ user: null as object | null }));

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return { ...actual, fetchEvent: vi.fn(), fetchEventSchedule: vi.fn(), fetchMyPlan: vi.fn() };
});
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: authState.user, loading: false }) }));

const event: CalendarEvent = {
    event_id: 'movida-2026', calendar_id: 'calendar-1', title: 'Movida 2026', description: null,
    location: 'Prague', city: 'Prague', country: 'Czechia', latitude: null, longitude: null,
    start: '2026-10-15T08:00:00Z', end: '2026-10-17T04:00:00Z', all_day: false, color: null,
    view_count: 0, price_min: null, price_max: null, price_currency: null, price_is_free: null, links: null, tags: [],
};
const schedule: EventSchedule = {
    event_id: event.event_id, timezone: 'Europe/Prague', day_start_hour: 6, days: ['2026-10-15', '2026-10-16'],
    venues: [], rooms: [], levels: [{ id: 1, label: 'Open', notation: null, sort_order: 0 }, { id: 2, label: 'Advanced', notation: null, sort_order: 1 }],
    activity_types: [{ id: 1, name: 'Workshop', color: 'blue', sort_order: 0 }],
    sessions: [
        { id: 'thursday', title: 'Thursday Session', instructors: 'Maya', start: '2026-10-15T12:00:00Z', end: '2026-10-15T13:00:00Z', room_id: null, venue_id: null, level_id: 1, activity_type_id: 1, attendee_note: null, allow_plan: true, is_cancelled: false },
        { id: 'friday', title: 'Friday Session', instructors: 'Alexis Ruiz', start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z', room_id: null, venue_id: null, level_id: 2, activity_type_id: 1, attendee_note: null, allow_plan: true, is_cancelled: false },
    ],
    version: 1, published_at: '2026-09-01T12:00:00Z',
};

function renderPage(path = '/event/movida-2026/program') {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, eventScheduleEnabled: true }, updateFlag: vi.fn(), ready: true }}>
                <Routes><Route path="/event/:eventId/program/*" element={<EventProgramPage />} /></Routes>
            </FeatureFlagsContext.Provider>
        </MemoryRouter>,
    );
}

describe('EventProgramPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
        authState.user = null;
        vi.mocked(fetchEvent).mockResolvedValue(event);
        vi.mocked(fetchEventSchedule).mockResolvedValue(schedule);
        vi.mocked(fetchMyPlan).mockResolvedValue({ entries: [] });
    });
    afterEach(() => vi.useRealTimers());

    it('does not load a public schedule while the feature is disabled', async () => {
        render(
            <MemoryRouter initialEntries={['/event/movida-2026/program']}>
                <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, eventScheduleEnabled: false }, updateFlag: vi.fn(), ready: true }}>
                    <Routes><Route path="/event/:eventId/program" element={<EventProgramPage />} /></Routes>
                </FeatureFlagsContext.Provider>
            </MemoryRouter>,
        );

        expect(await screen.findByText('The event program is not available.')).toBeInTheDocument();
        expect(fetchEventSchedule).not.toHaveBeenCalled();
    });

    it('opens on the current program day even when an older day was stored', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-10-16T12:30:00Z'));
        sessionStorage.setItem('program:movida-2026:day', '2026-10-15');
        renderPage();

        expect(await screen.findByRole('button', { name: /Friday Session.*Now/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { current: 'date' })).toHaveTextContent('16');
        expect(screen.queryByRole('button', { name: /Thursday Session/ })).not.toBeInTheDocument();
    });

    it('filters program sessions by instructor and level', async () => {
        renderPage('/event/movida-2026/program?day=2026-10-16');
        expect(await screen.findByRole('button', { name: /Friday Session/ })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search instructors' }), { target: { value: 'maya' } });
        expect(screen.queryByRole('button', { name: /Friday Session/ })).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search instructors' }), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
        expect(screen.queryByRole('button', { name: /Friday Session/ })).not.toBeInTheDocument();
    });

    it('shows the complete plan without program date or filter controls', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-10-16T12:30:00Z'));
        authState.user = { id: 'dancer' };
        vi.mocked(fetchMyPlan).mockResolvedValue({
            entries: [
                { session_id: 'thursday', status: 'active', session: schedule.sessions[0] },
                { session_id: 'friday', status: 'active', session: schedule.sessions[1] },
            ]
        });
        renderPage('/event/movida-2026/program/plan');

        expect(await screen.findByText('Thursday Session')).toBeInTheDocument();
        expect(screen.getByText('Friday Session')).toBeInTheDocument();
        expect(screen.getByText('Now')).toBeInTheDocument();
        expect(screen.getByText('Friday Session').closest('article')).toHaveAttribute('aria-current', 'time');
        expect(screen.queryByRole('searchbox', { name: 'Search instructors' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { current: 'date' })).not.toBeInTheDocument();
    });
});
