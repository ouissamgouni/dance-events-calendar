import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addScheduleEditor, applyScheduleImport, createAdminEventSchedule, createScheduleOverviewItem, createScheduleVenue, exportEventSchedule, fetchAdminEventSchedule, fetchAdminUsers, fetchEvent, fetchEventScheduleEditorAccess, fetchOptionalAdminEventSchedule, fetchScheduleEditors, fetchScheduleImportSchema, fetchSchedulePlanners, notifyProgram, fetchProgramNotifyCandidates, fetchSchedulePublishPreview, previewScheduleImport, publishEventSchedule, removeScheduleEditor, revertScheduleChange, unpublishEventSchedule, updateAdminEventSchedule, updateScheduleOverviewItem, updateScheduleSession, type AdminUserRow } from '../api';
import type { AdminEventSchedule, CalendarEvent } from '../types';
import AdminEventSchedulePage from './AdminEventSchedulePage';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return { ...actual, addScheduleEditor: vi.fn(), applyScheduleImport: vi.fn(), createAdminEventSchedule: vi.fn(), createScheduleOverviewItem: vi.fn(), createScheduleVenue: vi.fn(), exportEventSchedule: vi.fn(), fetchAdminEventSchedule: vi.fn(), fetchAdminUsers: vi.fn(), fetchEvent: vi.fn(), fetchEventScheduleEditorAccess: vi.fn(), fetchOptionalAdminEventSchedule: vi.fn(), fetchScheduleEditors: vi.fn(), fetchScheduleImportSchema: vi.fn(), fetchSchedulePlanners: vi.fn(), previewScheduleImport: vi.fn(), publishEventSchedule: vi.fn(), fetchProgramNotifyCandidates: vi.fn(), fetchSchedulePublishPreview: vi.fn(), notifyProgram: vi.fn(), unpublishEventSchedule: vi.fn(), revertScheduleChange: vi.fn(), removeScheduleEditor: vi.fn(), updateAdminEventSchedule: vi.fn(), updateScheduleOverviewItem: vi.fn(), updateScheduleSession: vi.fn() };
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
    contributors: [{ id: 1, external_id: 'maya', display_name: 'Maya', sort_order: 0 }, { id: 2, external_id: 'marta', display_name: 'DJ Marta', sort_order: 1 }],
    sessions: [{ id: 'session-1', title: 'Musicality', instructors: 'Maya', contributors: [{ contributor_id: 1, role: 'instructor', position: 0 }], start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z', room_id: 1, venue_id: 1, level_id: 1, activity_type_id: 1, attendee_note: null, allow_plan: true, is_cancelled: false }],
    version: 1,
    published_at: '2026-09-01T12:00:00Z',
    issues: [],
    diff: { added_session_ids: [], removed_session_ids: [], changed_sessions: {}, configuration_changed: false, changes: [] },
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
            notification_summary: { impacted_planners: 1, going_attendees_notified: 2, in_app_created: 3, going_attendees: 3 },
        });
        vi.mocked(fetchProgramNotifyCandidates).mockResolvedValue([]);
        vi.mocked(fetchSchedulePublishPreview).mockResolvedValue({ impacted_user_ids: [], sample_message: null });
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

    it('opens the Overview section and adds a moment to a linked item', async () => {
        const workshops = { id: 'workshops', external_id: null, parent_id: null, title: 'Workshops', subtitle: null, description: null, url: null, url_label: null, start: '2026-10-16T10:00:00Z', end: '2026-10-16T14:00:00Z', activity_type_id: 1, venue_id: null, room_ids: [], opens_detail: true, is_cancelled: false, sort_order: 0 };
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({
            ...schedule,
            overview_items: [workshops],
            issues: [{ code: 'overview_outside_schedule_days', severity: 'warning', message: 'Workshops is outside the configured days', session_ids: [], overview_item_ids: ['workshops'] }],
        });
        vi.mocked(createScheduleOverviewItem).mockResolvedValue({ ...workshops, id: 'moment', parent_id: 'workshops', opens_detail: false });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        expect(await screen.findByText('→ 1 session in full schedule')).toBeInTheDocument();
        expect(screen.getByText('Workshops is outside the configured days')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Add moment' }));

        expect(screen.getByRole('dialog', { name: 'Add moment' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Part of' })).toHaveValue('workshops');
        expect(screen.queryByRole('checkbox', { name: 'Has detailed schedule' })).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: 'Attendees can add to My Plan' })).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Teacher demo' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(createScheduleOverviewItem).toHaveBeenCalledWith(event.event_id, expect.objectContaining({
            parent_id: 'workshops',
            title: 'Teacher demo',
            start: '2026-10-16T10:00:00.000Z',
            end: '2026-10-16T11:00:00.000Z',
            opens_detail: false,
            allow_plan: false,
        })));
    });

    it('lets editors make a top-level overview item plannable', async () => {
        const bootcamp = { id: 'bootcamp', external_id: null, parent_id: null, title: 'Bootcamp', subtitle: null, description: null, url: null, url_label: null, start: '2026-10-16T10:00:00Z', end: '2026-10-16T14:00:00Z', activity_type_id: 1, venue_id: null, room_ids: [], opens_detail: false, allow_plan: false, is_cancelled: false, sort_order: 0 };
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({ ...schedule, overview_items: [bootcamp] });
        vi.mocked(updateScheduleOverviewItem).mockResolvedValue({ ...bootcamp, allow_plan: true });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: /Bootcamp/ }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Attendees can add to My Plan' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(updateScheduleOverviewItem).toHaveBeenCalledWith(event.event_id, 'bootcamp', expect.objectContaining({ allow_plan: true })));
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
        expect(screen.getByRole('checkbox', { name: 'Grand Hall' })).toBeChecked();
        fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Find the clave.' } });
        expect(screen.getByLabelText('Contributor 1')).toHaveValue('1');
        fireEvent.change(screen.getByLabelText('Contributor 1 role'), { target: { value: 'performer' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add artist or instructor' }));
        expect(screen.getByLabelText('Contributor 2')).toHaveValue('2');
        fireEvent.change(screen.getByLabelText('Contributor 2 role'), { target: { value: 'dj' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(updateScheduleSession).toHaveBeenCalledWith(event.event_id, 'session-1', expect.objectContaining({
            instructors: null,
            description: 'Find the clave.',
            room_id: 1,
            room_ids: [1],
            contributors: [
                { contributor_id: 1, role: 'performer' },
                { contributor_id: 2, role: 'dj' },
            ],
        })));
    });

    it('shows a session save error inside the editor dialog', async () => {
        vi.mocked(updateScheduleSession).mockRejectedValueOnce(new Error('Session overlaps another session'));
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: /Musicality/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await within(screen.getByRole('dialog', { name: 'Edit session' })).findByRole('alert')).toHaveTextContent('Session overlaps another session');
    });

    it('shows an overview save error inside the editor dialog', async () => {
        const workshops = { id: 'workshops', external_id: null, parent_id: null, title: 'Workshops', subtitle: null, description: null, url: null, url_label: null, start: '2026-10-16T10:00:00Z', end: '2026-10-16T14:00:00Z', activity_type_id: 1, venue_id: null, room_ids: [], opens_detail: true, is_cancelled: false, sort_order: 0 };
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({ ...schedule, overview_items: [workshops] });
        vi.mocked(createScheduleOverviewItem).mockRejectedValueOnce(new Error('Moment overlaps its parent'));
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Add moment' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Teacher demo' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await within(screen.getByRole('dialog', { name: 'Add moment' })).findByRole('alert')).toHaveTextContent('Moment overlaps its parent');
    });

    it('shows a config save error inside the editor dialog', async () => {
        vi.mocked(createScheduleVenue).mockRejectedValueOnce(new Error('Venue name already exists'));
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'locations' }));
        fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
        fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Palace' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await within(screen.getByRole('dialog', { name: 'Add venue' })).findByRole('alert')).toHaveTextContent('Venue name already exists');
    });

    it('requires preview before applying imported JSON to the draft', async () => {
        vi.mocked(previewScheduleImport).mockResolvedValue({
            document: importDocument,
            operations: { created: 1, updated: 0, removed: 0, unchanged: 0 },
            changes: [{ entity_type: 'session', operation: 'create', entity_id: 'sample-session', label: 'Sample Session', fields: [] }],
            issues: [],
            diff: schedule.diff,
        });
        vi.mocked(applyScheduleImport).mockResolvedValue({
            document: importDocument,
            operations: { created: 1, updated: 0, removed: 0, unchanged: 0 },
            changes: [{ entity_type: 'session', operation: 'create', entity_id: 'sample-session', label: 'Sample Session', fields: [] }],
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
        fireEvent.click(screen.getByText('View 1 change detail'));
        expect(screen.getByText('Sample Session')).toBeInTheDocument();
        expect(apply).toBeEnabled();
        fireEvent.click(screen.getByRole('checkbox', { name: 'Apply create Sample Session' }));
        expect(screen.getByText('1 change will be skipped.')).toBeInTheDocument();
        fireEvent.click(apply);
        await waitFor(() => expect(applyScheduleImport).toHaveBeenCalledWith(event.event_id, 'merge', expect.any(Object), [expect.objectContaining({ entity_id: 'sample-session', operation: 'create' })]));
        await waitFor(() => expect(fetchAdminEventSchedule).toHaveBeenCalledTimes(1));
    });

    it('shows field changes before publishing', async () => {
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({
            ...schedule,
            diff: {
                added_session_ids: [],
                removed_session_ids: [],
                changed_sessions: { 'session-1': ['title'] },
                configuration_changed: false,
                changes: [{
                    entity_type: 'session',
                    operation: 'update',
                    entity_id: 'session-1',
                    label: 'Draft title',
                    fields: [{ field: 'title', before: 'Musicality', after: 'Draft title' }],
                }],
            },
        });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Publish (1)' }));
        fireEvent.click(screen.getByText('View 1 change detail'));

        expect(screen.getByText('Draft title')).toBeInTheDocument();
        expect(screen.getAllByText('Musicality')).toHaveLength(2);

        vi.mocked(revertScheduleChange).mockResolvedValue(schedule);
        fireEvent.click(screen.getByRole('button', { name: 'Revert Draft title' }));
        await waitFor(() => expect(revertScheduleChange).toHaveBeenCalledWith(event.event_id, expect.objectContaining({ entity_id: 'session-1', operation: 'update' })));
        expect(await screen.findByText('No content changes.')).toBeInTheDocument();
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

        expect(screen.getByLabelText('Search artists and instructors')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument();
        expect(screen.getByRole('cell', { name: 'Thursday Basics' })).toBeInTheDocument();
        expect(screen.getByRole('cell', { name: 'Musicality' })).toBeInTheDocument();
        expect(screen.getByRole('cell', { name: /Fri.*16|16.*Fri/ })).toBeInTheDocument();
    });

    it('uses focused tabs to manage program taxonomy', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'taxonomy' }));

        expect(screen.getByRole('tab', { name: 'Contributors, 2 items' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tabpanel', { name: 'Contributors' })).toHaveTextContent('DJ Marta');
        expect(screen.queryByText('Open level')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('tab', { name: 'Levels, 1 item' }));
        expect(screen.getByRole('tabpanel', { name: 'Levels' })).toHaveTextContent('Open level');
        fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
        expect(screen.getByRole('dialog', { name: 'Add level' })).toBeInTheDocument();
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
        expect(screen.getByRole('button', { name: 'export' })).toBeEnabled();
        expect(screen.queryByText('dancer@example.com')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
        expect(screen.getByTitle('Draft attendee preview')).toHaveAttribute('src', '/event/movida-2026/program?preview=draft&embed=program');
    });

    it('saves the grid session color mode as soon as it changes', async () => {
        vi.mocked(updateAdminEventSchedule).mockResolvedValue({ ...schedule, session_color_mode: 'activity_type_stripe' });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'settings' }));
        const mode = screen.getByRole('combobox', { name: /Color sessions in the grid/ });
        expect(mode).toHaveValue('room');
        fireEvent.change(mode, { target: { value: 'activity_type_stripe' } });

        await waitFor(() => expect(updateAdminEventSchedule).toHaveBeenCalledWith(event.event_id, { session_color_mode: 'activity_type_stripe' }));
        expect(await screen.findByText('Saved to draft')).toBeInTheDocument();
        expect(mode).toHaveValue('activity_type_stripe');
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

    it('marks sessions with warnings in the grid and lists them in the sessions view', async () => {
        const footwork = { ...schedule.sessions[0], id: 'session-2', title: 'Footwork', start: '2026-10-16T12:30:00Z', end: '2026-10-16T13:30:00Z' };
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({
            ...schedule,
            sessions: [schedule.sessions[0], footwork],
            issues: [{ code: 'room_overlap', severity: 'warning', message: 'Musicality overlaps Footwork in the same room', session_ids: ['session-1', 'session-2'] }],
        });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        expect(await screen.findAllByTestId('session-issue-icon')).toHaveLength(2);
        fireEvent.click(screen.getByRole('button', { name: '1 warning' }));
        expect(screen.getByRole('button', { name: 'Issues · 2' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getAllByText('Musicality overlaps Footwork in the same room')).toHaveLength(2);
        fireEvent.click(screen.getByText('Footwork'));
        expect(screen.getByRole('dialog', { name: 'Edit session' })).toBeInTheDocument();
    });

    it('labels new and edited sessions and summarizes unpublished changes', async () => {
        const footwork = { ...schedule.sessions[0], id: 'session-2', title: 'Footwork', start: '2026-10-16T14:00:00Z', end: '2026-10-16T15:00:00Z' };
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({
            ...schedule,
            sessions: [schedule.sessions[0], footwork],
            diff: {
                added_session_ids: ['session-2'],
                removed_session_ids: [],
                changed_sessions: { 'session-1': ['start', 'end'] },
                configuration_changed: false,
                changes: [
                    { entity_type: 'session', operation: 'create', entity_id: 'session-2', label: 'Footwork', fields: [] },
                    { entity_type: 'session', operation: 'update', entity_id: 'session-1', label: 'Musicality', fields: [{ field: 'start', before: null, after: null }] },
                ],
            },
        });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        const status = await screen.findByTestId('program-status');
        expect(status).toHaveTextContent('Version 1 · 2 unpublished changes');
        expect(screen.getByText('New')).toBeInTheDocument();
        expect(screen.getByText('Edited')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(screen.getByRole('dialog', { name: 'Publish program' })).toBeInTheDocument();
    });

    it('publishes and notifies from one sheet, with planners whose sessions changed getting a personal version', async () => {
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({
            ...schedule,
            diff: {
                added_session_ids: [],
                removed_session_ids: [],
                changed_sessions: { 'session-1': ['start'] },
                configuration_changed: false,
                changes: [{ entity_type: 'session', operation: 'update', entity_id: 'session-1', label: 'Musicality', fields: [{ field: 'start', before: '12:00', after: '14:00' }] }],
            },
        });
        vi.mocked(fetchProgramNotifyCandidates).mockResolvedValue([
            { user_id: 'planner', email: 'planner@example.com', name: null, handle: null, email_enabled: true, push_enabled: true, has_push_subscription: false, already_notified: false, is_going: true, has_plan: true },
            { user_id: 'going', email: 'going@example.com', name: null, handle: null, email_enabled: false, push_enabled: false, has_push_subscription: false, already_notified: false, is_going: true, has_plan: false },
            { user_id: 'impacted', email: 'impacted@example.com', name: null, handle: null, email_enabled: true, push_enabled: true, has_push_subscription: false, already_notified: false, is_going: true, has_plan: true },
        ]);
        vi.mocked(fetchSchedulePublishPreview).mockResolvedValue({ impacted_user_ids: ['impacted'], sample_message: 'Musicality: has a new time.' });
        vi.mocked(notifyProgram).mockResolvedValue({ emailed: 1, pushed: 0, in_app_created: 2, results: [{ user_id: 'planner', email: 'planner@example.com', status: 'sent', email_status: 'sent', push_status: 'unavailable' }, { user_id: 'going', email: 'going@example.com', status: 'sent', email_status: 'disabled', push_status: 'disabled' }] });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Publish (1)' }));
        expect(screen.getByRole('switch', { name: 'Notify attendees' })).toBeChecked();
        expect(await screen.findByText('3 people · 1 personal plan update')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
        const planChip = screen.getByRole('button', { name: 'Plan changed · 1' });
        expect(planChip).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Everyone else going · 2' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Program updated');
        expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Moved: Musicality → new time');
        expect(screen.queryByText(/turned off program emails and push/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '1 in-app only' }));
        expect(screen.getByText(/1 turned off program emails and push/)).toBeInTheDocument();
        expect(screen.getByText('Plan changed: “Musicality: has a new time.”')).toBeInTheDocument();
        fireEvent.click(planChip);
        expect(screen.getByRole('button', { name: 'Everyone going · 3' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Publish & notify 3' })).toBeInTheDocument();
        fireEvent.click(planChip);
        fireEvent.click(screen.getByRole('button', { name: 'Everyone else going · 2' }));
        expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Publish & notify 1' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Everyone else going · 2' }));
        fireEvent.click(screen.getByRole('button', { name: 'Publish & notify 3' }));

        await waitFor(() => expect(publishEventSchedule).toHaveBeenCalledWith(event.event_id, { notifyImpactedPlanners: true }));
        await waitFor(() => expect(notifyProgram).toHaveBeenCalledWith(event.event_id, {
            user_ids: ['planner', 'going'],
            reason: 'updated',
            title: 'Program updated',
            message: 'Moved: Musicality → new time',
        }));
        expect(await screen.findByRole('dialog', { name: 'Version 2 published' })).toBeInTheDocument();
        expect(screen.getByText(/3 people notified\s+· 1 plan update/)).toBeInTheDocument();
    });

    it('publishes without notifying anyone when the switch is off', async () => {
        vi.mocked(fetchProgramNotifyCandidates).mockResolvedValue([
            { user_id: 'going', email: 'going@example.com', name: null, handle: null, email_enabled: true, push_enabled: true, has_push_subscription: false, already_notified: false, is_going: true, has_plan: false },
        ]);
        vi.mocked(publishEventSchedule).mockResolvedValue({ ...schedule, version: 2, notification_summary: { impacted_planners: 0, going_attendees_notified: 0, in_app_created: 0, going_attendees: 1 } });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
        expect(await screen.findByRole('button', { name: 'Publish & notify 1' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('switch', { name: 'Notify attendees' }));
        expect(screen.getByText('Nobody will be notified')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('dialog', { name: 'Publish program' }).querySelector('button.bg-action') as HTMLButtonElement);

        await waitFor(() => expect(publishEventSchedule).toHaveBeenCalledWith(event.event_id, { notifyImpactedPlanners: false }));
        expect(await screen.findByText('Nobody was notified.')).toBeInTheDocument();
        expect(notifyProgram).not.toHaveBeenCalled();
    });

    it('unpublishes and sends the under-work notice from one sheet', async () => {
        vi.mocked(unpublishEventSchedule).mockResolvedValue({ unpublished_at: '2026-10-21T10:00:00Z' });
        vi.mocked(fetchProgramNotifyCandidates).mockResolvedValue([
            { user_id: 'going', email: 'going@example.com', name: null, handle: null, email_enabled: true, push_enabled: true, has_push_subscription: false, already_notified: false, is_going: true, has_plan: false },
        ]);
        vi.mocked(notifyProgram).mockResolvedValue({ emailed: 1, pushed: 0, in_app_created: 1, results: [{ user_id: 'going', email: 'going@example.com', status: 'sent', email_status: 'sent', push_status: 'unavailable' }] });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));
        expect(unpublishEventSchedule).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Unpublish program?' })).toBeInTheDocument();
        fireEvent.click(await screen.findByRole('button', { name: 'Unpublish & notify 1' }));

        await waitFor(() => expect(unpublishEventSchedule).toHaveBeenCalledWith(event.event_id));
        await waitFor(() => expect(notifyProgram).toHaveBeenCalledWith(event.event_id, {
            user_ids: ['going'],
            reason: 'under_work',
            title: 'Program under work',
            message: "The program is being updated. We'll let you know when it's back.",
        }));
        expect(await screen.findByRole('dialog', { name: 'Program unpublished' })).toBeInTheDocument();
        expect(screen.getByText(/1 person notified/)).toBeInTheDocument();
    });

    it('announces the first publication without offering a broad-update option', async () => {
        vi.mocked(fetchOptionalAdminEventSchedule).mockResolvedValue({ ...schedule, version: null, published_at: null });
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'export' }));
        expect(screen.getByRole('heading', { name: 'Export options' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Preview PDF' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: 'Download calendar (.ics)' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Notify attendees' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
        expect(screen.getByText(/Publishing makes this program visible to attendees/)).toBeInTheDocument();
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
