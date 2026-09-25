import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyScheduleDancePreset, applyScheduleImport, exportEventSchedule, fetchAdminEventSchedule, fetchEvent, fetchScheduleImportSchema, fetchScheduleProgramCandidates, notifyScheduleProgram, notifySchedulePublicationGoing, previewScheduleImport, publishEventSchedule } from '../api';
import type { AdminEventSchedule, CalendarEvent } from '../types';
import AdminEventSchedulePage from './AdminEventSchedulePage';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return { ...actual, applyScheduleDancePreset: vi.fn(), applyScheduleImport: vi.fn(), exportEventSchedule: vi.fn(), fetchAdminEventSchedule: vi.fn(), fetchEvent: vi.fn(), fetchScheduleImportSchema: vi.fn(), fetchScheduleProgramCandidates: vi.fn(), notifyScheduleProgram: vi.fn(), notifySchedulePublicationGoing: vi.fn(), previewScheduleImport: vi.fn(), publishEventSchedule: vi.fn() };
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
        vi.mocked(fetchEvent).mockResolvedValue(event);
        vi.mocked(fetchAdminEventSchedule).mockResolvedValue(schedule);
        vi.mocked(exportEventSchedule).mockResolvedValue(importDocument);
        vi.mocked(fetchScheduleImportSchema).mockResolvedValue({ schema: {}, example: exampleDocument });
        vi.mocked(applyScheduleDancePreset).mockResolvedValue({ created: 3 });
        vi.mocked(fetchScheduleProgramCandidates).mockResolvedValue([{ user_id: 'user-1', email: 'dancer@example.com', name: 'Dancer', handle: 'dancer', email_enabled: true, push_enabled: true, has_push_subscription: false, already_notified: false }]);
        vi.mocked(notifyScheduleProgram).mockResolvedValue({ emailed: 1, pushed: 0, in_app_created: 1, results: [{ user_id: 'user-1', email: 'dancer@example.com', status: 'sent', email_status: 'sent', push_status: 'unavailable' }] });
        vi.mocked(publishEventSchedule).mockResolvedValue({
            ...schedule,
            version: 2,
            notification_summary: { impacted_planners: 1, in_app_created: 1, emailed: 1, pushed: 0, going_attendees: 3, remaining_going_attendees: 2 },
        });
        vi.mocked(notifySchedulePublicationGoing).mockResolvedValue({ emailed: 1, pushed: 0, in_app_created: 2, results: [] });
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
        await waitFor(() => expect(fetchAdminEventSchedule).toHaveBeenCalledTimes(2));
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

    it('applies the optional Dance taxonomy preset', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'taxonomy' }));
        fireEvent.click(screen.getByRole('button', { name: 'Apply Dance preset' }));

        await waitFor(() => expect(applyScheduleDancePreset).toHaveBeenCalledWith(event.event_id));
        expect(await screen.findByText('Added 3 levels.')).toBeInTheDocument();
        expect(fetchAdminEventSchedule).toHaveBeenCalledTimes(2);
    });

    it('notifies selected Going attendees about the published program', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'settings' }));
        fireEvent.click(screen.getByRole('button', { name: 'Notify attendees' }));
        expect(await screen.findByText('dancer@example.com')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('checkbox', { name: /Dancer/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Notify 1 attendee' }));

        await waitFor(() => expect(notifyScheduleProgram).toHaveBeenCalledWith(event.event_id, ['user-1'], false));
        expect(await screen.findByText('1 in-app · 1 email · 0 push')).toBeInTheDocument();
        expect(screen.getByText(/push unavailable/)).toBeInTheDocument();
    });

    it('offers remaining Going attendees after impacted planners are notified', async () => {
        render(
            <MemoryRouter initialEntries={['/admin/events/movida-2026/schedule']}>
                <Routes><Route path="/admin/events/:eventId/schedule" element={<AdminEventSchedulePage />} /></Routes>
            </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
        fireEvent.click(screen.getByRole('dialog', { name: 'Publish schedule' }).querySelector('button.bg-action') as HTMLButtonElement);

        expect(await screen.findByText('1 impacted planner notified automatically')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Notify all Going attendees' }));

        await waitFor(() => expect(notifySchedulePublicationGoing).toHaveBeenCalledWith(event.event_id, 2));
        expect(await screen.findByText('2 in-app · 1 email · 0 push')).toBeInTheDocument();
    });
});
