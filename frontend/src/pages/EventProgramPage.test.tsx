import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadMyPlanIcs, fetchAdminEventSchedule, fetchEvent, fetchEventSchedule, fetchEventScheduleEditorAccess, fetchMyPlan } from '../api';
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext';
import type { CalendarEvent, EventSchedule } from '../types';
import EventProgramPage from './EventProgramPage';
import { saveDownload } from '../utils/download';
import { trackProgramViewed } from '../utils/tracking';

const authState = vi.hoisted(() => ({ user: null as object | null }));

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return { ...actual, downloadMyPlanIcs: vi.fn(), fetchAdminEventSchedule: vi.fn(), fetchEvent: vi.fn(), fetchEventSchedule: vi.fn(), fetchEventScheduleEditorAccess: vi.fn(), fetchMyPlan: vi.fn() };
});
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: authState.user, loading: false }) }));
vi.mock('../utils/download', () => ({ saveDownload: vi.fn() }));
vi.mock('../utils/tracking', () => ({ trackProgramViewed: vi.fn() }));

const event: CalendarEvent = {
    event_id: 'movida-2026', calendar_id: 'calendar-1', title: 'Movida 2026', description: null,
    location: 'Prague', city: 'Prague', country: 'Czechia', latitude: null, longitude: null,
    start: '2026-10-15T08:00:00Z', end: '2026-10-17T04:00:00Z', all_day: false, color: null,
    view_count: 0, price_min: null, price_max: null, price_currency: null, price_is_free: null, links: null, tags: [],
};
const schedule: EventSchedule = {
    event_id: event.event_id, timezone: 'Europe/Prague', day_start_hour: 6, days: ['2026-10-15', '2026-10-16'],
    venues: [], rooms: [], levels: [{ id: 1, label: 'Open Level', notation: null, sort_order: 0 }, { id: 2, label: 'Intermediate', notation: null, sort_order: 1 }, { id: 3, label: 'Advanced', notation: null, sort_order: 2 }, { id: 4, label: 'Beginner', notation: null, sort_order: 3 }],
    activity_types: [{ id: 1, name: 'Workshop', color: 'blue', sort_order: 0 }, { id: 2, name: 'Social', color: 'green', sort_order: 1 }, { id: 3, name: 'Afterparty', color: 'slate', sort_order: 2 }],
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

function LocationProbe() {
    const location = useLocation();
    return <output data-testid="location">{location.pathname}</output>;
}

describe('EventProgramPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
        authState.user = null;
        vi.mocked(fetchEvent).mockResolvedValue(event);
        vi.mocked(fetchAdminEventSchedule).mockResolvedValue({
            ...schedule,
            issues: [],
            diff: { added_session_ids: [], removed_session_ids: [], changed_sessions: {}, configuration_changed: false },
        });
        vi.mocked(fetchEventSchedule).mockResolvedValue(schedule);
        vi.mocked(fetchEventScheduleEditorAccess).mockResolvedValue({ can_edit: false });
        vi.mocked(fetchMyPlan).mockResolvedValue({ entries: [] });
        vi.mocked(downloadMyPlanIcs).mockResolvedValue({ blob: new Blob(['calendar']), filename: 'movida-2026-my-plan.ics' });
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

    it('tracks each successful public Program tab view once', async () => {
        authState.user = { id: 'dancer' };
        renderPage();

        await screen.findByRole('button', { name: /Thursday Session/ });
        expect(trackProgramViewed).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: '16 Fri' }));
        expect(await screen.findByRole('button', { name: /Friday Session/ })).toBeInTheDocument();
        expect(trackProgramViewed).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'My Plan' }));
        expect(trackProgramViewed).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Program' }));
        await waitFor(() => expect(trackProgramViewed).toHaveBeenCalledTimes(2));
    });

    it('does not track direct My Plan or draft preview visits', async () => {
        const { unmount } = renderPage('/event/movida-2026/program/plan');
        await screen.findByText('Sign in to build My Plan');
        expect(trackProgramViewed).not.toHaveBeenCalled();

        unmount();
        renderPage('/event/movida-2026/program?preview=draft&embed=program');
        await screen.findByRole('button', { name: /Thursday Session/ });
        expect(trackProgramViewed).not.toHaveBeenCalled();
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

    it('applies draft filters from a compact sheet and summarizes them', async () => {
        renderPage('/event/movida-2026/program?day=2026-10-16');
        expect(await screen.findByRole('button', { name: /Friday Session/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Filter schedule' })).toBeInTheDocument();
        expect(screen.queryByLabelText('Search instructors')).not.toBeInTheDocument();
        expect(screen.queryByText('Prague')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Filter schedule' }));
        let sheet = screen.getByRole('dialog', { name: 'Filter schedule' });
        expect(within(sheet).getByRole('button', { name: 'Open Level' })).toBeInTheDocument();
        expect(within(sheet).getByRole('button', { name: 'Intermediate' })).toBeInTheDocument();
        expect(within(sheet).getByRole('button', { name: 'Advanced' })).toBeInTheDocument();
        expect(within(sheet).queryByRole('button', { name: 'Beginner' })).not.toBeInTheDocument();
        expect(within(sheet).queryByRole('button', { name: 'Afterparty' })).not.toBeInTheDocument();

        fireEvent.click(within(sheet).getByRole('button', { name: 'Open Level' }));
        fireEvent.click(within(sheet).getByRole('button', { name: 'Workshop' }));
        fireEvent.click(within(sheet).getByRole('button', { name: 'All instructors' }));
        const instructorSheet = screen.getByRole('dialog', { name: 'Select instructor' });
        expect(within(instructorSheet).getByRole('radio', { name: 'All instructors' })).toBeInTheDocument();
        fireEvent.change(within(instructorSheet).getByLabelText('Search instructors'), { target: { value: 'may' } });
        expect(within(instructorSheet).getByRole('radio', { name: 'All instructors' })).toBeInTheDocument();
        fireEvent.click(within(instructorSheet).getByRole('radio', { name: 'Maya' }));
        sheet = screen.getByRole('dialog', { name: 'Filter schedule' });
        expect(within(sheet).getByRole('button', { name: 'Maya' })).toBeInTheDocument();
        expect(within(sheet).getByRole('button', { name: 'Show 1 session' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Friday Session/ })).toBeInTheDocument();

        fireEvent.click(within(sheet).getByRole('button', { name: 'Show 1 session' }));
        expect(screen.queryByRole('button', { name: /Friday Session/ })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Thursday Session/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open Level · Workshop · +1' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '15 Thu · 1' })).toBeInTheDocument();
    });

    it('preserves dismissed drafts and supports reset and direct clear', async () => {
        renderPage('/event/movida-2026/program?day=2026-10-16');
        await screen.findByRole('button', { name: /Friday Session/ });

        fireEvent.click(screen.getByRole('button', { name: 'Filter schedule' }));
        let sheet = screen.getByRole('dialog', { name: 'Filter schedule' });
        expect(within(sheet).getByRole('button', { name: 'Reset' })).toBeDisabled();
        fireEvent.click(within(sheet).getByRole('button', { name: 'Intermediate' }));
        expect(within(sheet).getByRole('button', { name: 'Reset' })).toBeEnabled();
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
        expect(screen.getByRole('button', { name: 'Filter schedule' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Friday Session/ })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Filter schedule' }));
        sheet = screen.getByRole('dialog', { name: 'Filter schedule' });
        expect(within(sheet).getByRole('button', { name: 'Intermediate' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(within(sheet).getByRole('button', { name: 'Reset' }));
        expect(within(sheet).getByRole('button', { name: 'Intermediate' })).toHaveAttribute('aria-pressed', 'false');
        expect(within(sheet).getByRole('button', { name: 'Reset' })).toBeDisabled();
        expect(within(sheet).getByRole('button', { name: 'Show 2 sessions' })).toBeInTheDocument();
        fireEvent.click(within(sheet).getByRole('button', { name: 'Intermediate' }));
        fireEvent.click(within(sheet).getByRole('button', { name: 'Show 1 session' }));

        expect(screen.getByRole('button', { name: 'Intermediate' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Clear schedule filters' }));
        expect(screen.getByRole('button', { name: 'Filter schedule' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Clear schedule filters' })).not.toBeInTheDocument();
    });

    it('disables the apply action when no sessions match', async () => {
        renderPage();

        fireEvent.click(await screen.findByRole('button', { name: 'Filter schedule' }));
        const sheet = screen.getByRole('dialog', { name: 'Filter schedule' });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Advanced' }));

        expect(within(sheet).getByRole('button', { name: 'No sessions match' })).toBeDisabled();
    });

    it('searches every instructor in the nested picker', async () => {
        vi.mocked(fetchEventSchedule).mockResolvedValue({
            ...schedule,
            sessions: Array.from({ length: 10 }, (_, index) => ({
                ...schedule.sessions[0],
                id: `session-${index}`,
                title: `Session ${index}`,
                instructors: `Instructor ${index}`,
            })),
        });
        renderPage();

        fireEvent.click(await screen.findByRole('button', { name: 'Filter schedule' }));
        fireEvent.click(screen.getByRole('button', { name: 'All instructors' }));
        const sheet = screen.getByRole('dialog', { name: 'Select instructor' });

        expect(within(sheet).getAllByRole('radio')).toHaveLength(11);
        fireEvent.change(within(sheet).getByLabelText('Search instructors'), { target: { value: 'Instructor 9' } });
        expect(within(sheet).getAllByRole('radio')).toHaveLength(2);
        expect(within(sheet).getByRole('radio', { name: 'Instructor 9' })).toBeInTheDocument();
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
        expect(screen.queryByRole('button', { name: 'Filter schedule' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { current: 'date' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Export published program' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Download My Plan (.ics)' }));
        await waitFor(() => expect(downloadMyPlanIcs).toHaveBeenCalledWith('movida-2026'));
        expect(saveDownload).toHaveBeenCalledWith(expect.objectContaining({ filename: 'movida-2026-my-plan.ics' }));
    });

    it('hides attendee chrome in the embedded draft preview', async () => {
        renderPage('/event/movida-2026/program?preview=draft&embed=program');

        expect(await screen.findByRole('button', { name: /Thursday Session/ })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: event.title })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Back to event' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Draft preview/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'My Plan' })).not.toBeInTheDocument();
    });

    it('offers editor navigation only to an authorized signed-in user', async () => {
        authState.user = { id: 'editor' };
        vi.mocked(fetchEventScheduleEditorAccess).mockResolvedValue({ can_edit: true });
        render(
            <MemoryRouter initialEntries={['/event/movida-2026/program']}>
                <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, eventScheduleEnabled: true }, updateFlag: vi.fn(), ready: true }}>
                    <LocationProbe />
                    <Routes>
                        <Route path="/event/:eventId/program" element={<EventProgramPage />} />
                        <Route path="/event/:eventId/program/edit" element={<p>Program editor destination</p>} />
                        <Route path="/event/:eventId/program/export" element={<p>Program export destination</p>} />
                    </Routes>
                </FeatureFlagsContext.Provider>
            </MemoryRouter>,
        );

        expect(await screen.findByRole('button', { name: 'Export published program' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Edit program' }));

        expect(screen.getByText('Program editor destination')).toBeInTheDocument();
        expect(screen.getByTestId('location')).toHaveTextContent('/event/movida-2026/program/edit');
    });

    it('returns a direct Program visit to Event without adding a loop', async () => {
        render(
            <MemoryRouter initialEntries={['/event/movida-2026/program']}>
                <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, eventScheduleEnabled: true }, updateFlag: vi.fn(), ready: true }}>
                    <LocationProbe />
                    <Routes>
                        <Route path="/event/:eventId/program/*" element={<EventProgramPage />} />
                        <Route path="/event/:eventId" element={<p>Event detail destination</p>} />
                    </Routes>
                </FeatureFlagsContext.Provider>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Back to event' }));
        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/event/movida-2026'));
    });
});
