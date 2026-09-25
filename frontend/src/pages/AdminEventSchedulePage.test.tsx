import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addScheduleEditor, applyScheduleImport, createAdminEventSchedule, exportEventSchedule, fetchAdminEventSchedule, fetchAdminUsers, fetchEvent, fetchEventScheduleEditorAccess, fetchOptionalAdminEventSchedule, fetchScheduleEditors, fetchScheduleImportSchema, fetchSchedulePlanners, previewScheduleImport, publishEventSchedule, removeScheduleEditor, type AdminUserRow } from '../api';
import type { AdminEventSchedule, CalendarEvent } from '../types';
import AdminEventSchedulePage from './AdminEventSchedulePage';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return { ...actual, addScheduleEditor: vi.fn(), applyScheduleImport: vi.fn(), createAdminEventSchedule: vi.fn(), exportEventSchedule: vi.fn(), fetchAdminEventSchedule: vi.fn(), fetchAdminUsers: vi.fn(), fetchEvent: vi.fn(), fetchEventScheduleEditorAccess: vi.fn(), fetchOptionalAdminEventSchedule: vi.fn(), fetchScheduleEditors: vi.fn(), fetchScheduleImportSchema: vi.fn(), fetchSchedulePlanners: vi.fn(), previewScheduleImport: vi.fn(), publishEventSchedule: vi.fn(), removeScheduleEditor: vi.fn() };
});

const event: CalendarEvent = {
    event_id: 'movida-2026',
    calendar_id: 'calendar-1',
    title: 'Movida 2026',
    description: null,
    location: 'Prague',
    city: 'Prague',
    country: 'Czechia',
    latitude: null,
    longitude: null,
    start: '2026-10-16T08:00:00Z',
    end: '2026-10-18T04:00:00Z',
    all_day: false,
    color: null,
    view_count: 0,
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: null,
    links: null,
    tags: [],
};

const schedule: AdminEventSchedule = {
    event_id: event.event_id,
    timezone: 'Europe/Prague',
    day_start_hour: 6,
    days: ['2026-10-15', '2026-10-16'],
    venues: [{ id: 1, name: 'Palace', address: 'Old Town', sort_order: 0 }],
    rooms: [{ id: 1, venue_id: 1, name: 'Grand Hall', color: 'blue', sort_order: 0 }],
    levels: [{ id: 1, label: 'Open level', notation: null, sort_order: 0 }],
    activity_types: [{ id: 1, name: 'Workshop', color: 'blue', sort_order: 0 }],
    sessions: [{ id: 'session-1', title: 'Musicality', instructors: 'Maya', start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z', room_id: 1, venue_id: 1, level_id: 1, activity_type_id: 1, attendee_note: null, allow_plan: true, is_cancelled: false }],
    version: 1,
    published_at: '2026-09-01T12:00:00Z',
    issues: [],
    diff: { added_session_ids: [], removed_session_ids: [], changed_sessions: {}, configuration_changed: false },
};
const importDocument = { schema_version: 1 as const, event_id: event.event_id, timezone: 'Europe/Prague', day_start_hour: 6, days: ['2026-10-16'], venues: [], rooms: [], levels: [], activity_types: [], sessions: [] };
const exampleDocument = { ...importDocument, sessions: [{ external_id: 'sample-session', title: 'Sample Session', instructors: null, start: '2026-10-16T10:00:00', end: '2026-10-16T11:00:00', room_external_id: null, venue_external_id: null, level_external_id: null, activity_type_external_id: null, attendee_note: null, allow_plan: true, is_cancelled: false }] };

describe('AdminEventSchedulePage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fetchEvent).mockResolvedValue(event);
        vi.mocked(fetchAdminEventSchedule).mockResolvedValue(schedule);
        vi.mocked(fetchEventScheduleEditorAccess).mockResolvedValue({ can_edit: true });
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue(schedule);
        vi.mocked(fetchScheduleEditors).mockResolvedValue([]);
        vi.mocked(fetchAdminUsers).mockResolvedValue({ items: [], total: 0 });
        vi.mocked(exportEventSchedule).mockResolvedValue(importDocument);
        vi.mocked(fetchScheduleImportSchema).mockResolvedValue({ schema: {}, example: exampleDocument });
        vi.mocked(fetchSchedulePlanners).mockResolvedValue([{ user_id: 'user-1', email: 'dancer@example.com', name: 'Dancer', handle: 'dancer', going: true, planned_session_count: 1, sessions: [{ session_id: 'session-1', title: 'Musicality', start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z', status: 'active' }] }]);
        vi.mocked(publishEventSchedule).mockResolvedValue({
            ...schedule,
            version: 2,
            notification_summary: { impacted_planners: 1, going_attendees_notified: 2, in_app_created: 3, emailed: 1, pushed: 0, going_attendees: 3 },
        });
    });

    it('offers to create a program when the event has no schedule', async () => {
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue(null);
        vi.mocked(createAdminEventSchedule).mockResolvedValue({ ...schedule, version: null, published_at: null });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        expect(await screen.findByRole('heading', { name: "Create Movida 2026's program" })).toBeInTheDocument();
        expect(screen.queryByText('Schedule not found')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));

        await waitFor(() => expect(createAdminEventSchedule).toHaveBeenCalledWith(event.event_id, {
            timezone: expect.any(String),
            day_start_hour: 6,
        }));
        expect(await screen.findByRole('heading', { name: event.title })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    });

    it('opens a populated session editor from the schedule grid', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: /Musicality/ }));

        expect(screen.getByRole('dialog', { name: 'Edit session' })).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Musicality');
        expect(screen.getByLabelText('Room')).toHaveValue('1');
    });

    it('requires preview before applying imported JSON to the draft', async () => {
        vi.mocked(previewScheduleImport).mockResolvedValue({
            document: importDocument,
            operations: { created: 1, updated: 0, removed: 0, unchanged: 0 },
            issues: [],
            diff: schedule.diff,
        });
        vi.mocked(applyScheduleImport).mockResolvedValue({
            document: importDocument,
            operations: { created: 1, updated: 0, removed: 0, unchanged: 0 },
            issues: [],
            diff: schedule.diff,
        });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'settings' }));
        await waitFor(() => expect(screen.getByLabelText('Schedule JSON document')).toHaveValue(JSON.stringify(importDocument, null, 2)));
        const apply = screen.getByRole('button', { name: 'Apply to draft' });
        expect(apply).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Schedule JSON document'), {
            target: { value: JSON.stringify({ schema_version: 1, event_id: event.event_id, timezone: 'Europe/Prague', days: [], venues: [], rooms: [], levels: [], activity_types: [], sessions: [] }) },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));

        expect(await screen.findByText('No schedule warnings.')).toBeInTheDocument();
        expect(apply).toBeEnabled();
        fireEvent.click(apply);
        await waitFor(() => expect(applyScheduleImport).toHaveBeenCalledWith(event.event_id, 'merge', expect.any(Object)));
        await waitFor(() => expect(fetchAdminEventSchedule).toHaveBeenCalledTimes(1));
    });

    it('loads a standalone example and can reset to the current draft', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'settings' }));
        const editor = screen.getByLabelText('Schedule JSON document');
        await waitFor(() => expect(editor).toHaveValue(JSON.stringify(importDocument, null, 2)));
        expect(screen.getByText('External IDs')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Load example' }));
        await waitFor(() => expect(editor).toHaveValue(JSON.stringify(exampleDocument, null, 2)));

        fireEvent.click(screen.getByRole('button', { name: 'Reset to current draft' }));
        await waitFor(() => expect(editor).toHaveValue(JSON.stringify(importDocument, null, 2)));
    });

    it('reuses Program controls in the dated Sessions list', async () => {
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({
            ...schedule,
            sessions: [
                { ...schedule.sessions[0], id: 'session-0', title: 'Thursday Basics', start: '2026-10-15T12:00:00Z', end: '2026-10-15T13:00:00Z' },
                schedule.sessions[0],
            ],
        });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'sessions' }));

        expect(screen.getByLabelText('Search instructors')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument();
        expect(screen.getByRole('cell', { name: 'Thursday Basics' })).toBeInTheDocument();
        expect(screen.getByRole('cell', { name: 'Musicality' })).toBeInTheDocument();
        expect(screen.getByRole('cell', { name: /Fri.*16|16.*Fri/ })).toBeInTheDocument();
    });

    it('offers timezone choices and previews only the Program surface', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'settings' }));
        await waitFor(() => expect(screen.getByLabelText('Schedule JSON document')).toHaveValue(JSON.stringify(importDocument, null, 2)));
        const timezone = screen.getByRole('combobox', { name: 'Event timezone' });
        expect(timezone).toHaveAttribute('aria-autocomplete', 'list');
        fireEvent.focus(timezone);
        expect(screen.getByRole('listbox', { name: 'Timezone suggestions' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'UTC' })).toBeInTheDocument();
        fireEvent.change(timezone, { target: { value: 'Prag' } });
        expect(screen.queryByRole('option', { name: 'UTC' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('option', { name: 'Europe/Prague' }));
        expect(timezone).toHaveValue('Europe/Prague');
        expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
        expect(screen.queryByText('dancer@example.com')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
        expect(screen.getByTitle('Draft attendee preview')).toHaveAttribute('src', '/event/movida-2026/program?preview=draft&embed=program');
    });

    it('shows users who added sessions to their plans', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'settings' }));
        expect(screen.queryByText('dancer@example.com')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'View people' }));
        expect(screen.getByRole('dialog', { name: 'People with plans' })).toBeInTheDocument();
        expect(await screen.findByText('dancer@example.com')).toBeInTheDocument();
        expect(screen.getByText('Going')).toBeInTheDocument();
        expect(screen.getByText('1 session')).toBeInTheDocument();
        fireEvent.click(screen.getByText('dancer@example.com'));
        expect(screen.getByText('Musicality')).toBeInTheDocument();
    });

    it('offers one optional broad update before publishing', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Also notify all Going attendees/ }));
        fireEvent.click(screen.getByRole('dialog', { name: 'Publish schedule' }).querySelector('button.bg-action') as HTMLButtonElement);

        await waitFor(() => expect(publishEventSchedule).toHaveBeenCalledWith(event.event_id, true));
        expect(await screen.findByText('1 impacted planner notified')).toBeInTheDocument();
        expect(screen.getByText('2 additional Going attendees notified')).toBeInTheDocument();
        expect(screen.getByText('3 in-app · 1 email · 0 push')).toBeInTheDocument();
    });

    it('announces the first publication without offering a broad-update option', async () => {
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({ ...schedule, version: null, published_at: null });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

        expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
        expect(screen.getByText(/Publishing makes this program visible and announces it/)).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: /Also notify all Going attendees/ })).not.toBeInTheDocument();
    });

    it('shows a denied state when delegated editor access was revoked', async () => {
        vi.mocked(fetchEventScheduleEditorAccess).mockResolvedValue({ can_edit: false });
        render(
            <MemoryRouter initialEntries={['/event/movida-2026/program/edit']}>
                <Routes><Route path="/event/:eventId/program/edit" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        expect(await screen.findByRole('heading', { name: 'Program editor access required' })).toBeInTheDocument();
        expect(fetchOptionalAdminEventSchedule).not.toHaveBeenCalled();
    });

    it('loads the delegated editor without access-management controls', async () => {
        render(
            <MemoryRouter initialEntries={['/event/movida-2026/program/edit']}>
                <Routes><Route path="/event/:eventId/program/edit" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        expect(await screen.findByRole('button', { name: 'Back to program' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'settings' }));
        await waitFor(() => expect(screen.getByLabelText('Schedule JSON document')).toHaveValue(JSON.stringify(importDocument, null, 2)));
        expect(screen.queryByRole('heading', { name: 'Program editors' })).not.toBeInTheDocument();
        expect(fetchScheduleEditors).not.toHaveBeenCalled();
    });

    it('lets an admin add and revoke program editors', async () => {
        const candidate = {
            user_id: 'editor-1',
            email: 'editor@example.com',
            handle: 'editor',
            display_name: 'Event Editor',
            is_admin: false,
            deleted_at: null,
        } as AdminUserRow;
        const editor = {
            user_id: candidate.user_id,
            email: candidate.email,
            name: candidate.display_name,
            handle: candidate.handle,
            granted_at: '2026-09-25T12:00:00Z',
        };
        vi.mocked(fetchAdminUsers).mockResolvedValue({ items: [candidate], total: 1 });
        vi.mocked(addScheduleEditor).mockResolvedValue(editor);
        vi.mocked(removeScheduleEditor).mockResolvedValue(undefined);
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'settings' }));
        expect(await screen.findByRole('heading', { name: 'Program editors' })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('searchbox', { name: 'Add an editor' }), { target: { value: 'editor' } });
        await waitFor(() => expect(fetchAdminUsers).toHaveBeenCalledWith({ q: 'editor', limit: 20 }));
        fireEvent.click(await screen.findByRole('button', { name: /Event Editor.*editor@example.com.*Add/ }));
        await waitFor(() => expect(addScheduleEditor).toHaveBeenCalledWith(event.event_id, candidate.user_id));
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
        await waitFor(() => expect(removeScheduleEditor).toHaveBeenCalledWith(event.event_id, candidate.user_id));
    });
});
