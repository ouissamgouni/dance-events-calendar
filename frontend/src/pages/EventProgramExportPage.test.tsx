import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadPublishedProgramExport, fetchPublishedProgramExport } from '../api';
import type { ProgramExport } from '../types';
import { saveDownload } from '../utils/download';
import EventProgramExportPage from './EventProgramExportPage';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return { ...actual, downloadPublishedProgramExport: vi.fn(), fetchPublishedProgramExport: vi.fn() };
});
vi.mock('../utils/download', () => ({ saveDownload: vi.fn() }));

const program: ProgramExport = {
    event_id: 'movida-2026',
    event_title: 'Movida 2026',
    program_url: 'https://example.test/event/movida-2026/program',
    timezone: 'Europe/Prague',
    day_start_hour: 6,
    available_days: ['2026-10-16', '2026-10-17'],
    selected_days: ['2026-10-16', '2026-10-17'],
    venues: [{ id: 1, name: 'Palace', address: 'Old Town', sort_order: 0 }],
    rooms: [{ id: 2, venue_id: 1, name: 'Grand Hall', color: 'amber', sort_order: 0 }],
    levels: [{ id: 3, label: 'Open Level', notation: '**', sort_order: 0 }],
    activity_types: [{ id: 4, name: 'Workshop', color: 'blue', sort_order: 0 }],
    contributors: [{ id: 5, external_id: 'maya-and-guests', display_name: 'Maya and a long list of guest instructors', sort_order: 0 }],
    version: 2,
    published_at: '2026-09-01T12:00:00Z',
    sessions: [{
        id: 'session-1', title: 'Musicality with a long title that needs room to wrap', instructors: 'Maya and a long list of guest instructors', start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z',
        program_day: '2026-10-16', local_date: '2026-10-16', local_start_time: '14:00', local_end_time: '15:00',
        venue_id: 1, room_id: 2, level_id: 3, activity_type_id: 4, contributors: [{ contributor_id: 5, role: 'instructor', position: 0 }],
        venue: 'Palace', room: 'Grand Hall', address: 'Old Town', level: 'Open Level', activity_type: 'Workshop', attendee_note: null, is_cancelled: false, status: 'active',
    }, {
        id: 'session-2', title: 'Cancelled class', instructors: 'Maya', start: '2026-10-16T13:00:00Z', end: '2026-10-16T14:00:00Z',
        program_day: '2026-10-16', local_date: '2026-10-16', local_start_time: '15:00', local_end_time: '16:00',
        venue_id: 1, room_id: 2, level_id: 3, activity_type_id: 4, contributors: [],
        venue: 'Palace', room: 'Grand Hall', address: 'Old Town', level: 'Open Level', activity_type: 'Workshop', attendee_note: null, is_cancelled: true, status: 'cancelled',
    }, {
        id: 'session-3', title: 'Late Social', instructors: 'Maya', start: '2026-10-16T21:00:00Z', end: '2026-10-16T22:00:00Z',
        program_day: '2026-10-16', local_date: '2026-10-16', local_start_time: '23:00', local_end_time: '00:00',
        venue_id: 1, room_id: 2, level_id: 3, activity_type_id: 4, contributors: [],
        venue: 'Palace', room: 'Grand Hall', address: 'Old Town', level: 'Open Level', activity_type: 'Workshop', attendee_note: null, is_cancelled: false, status: 'active',
    }, {
        id: 'session-4', title: 'Saturday Musicality', instructors: 'Maya', start: '2026-10-17T12:00:00Z', end: '2026-10-17T13:00:00Z',
        program_day: '2026-10-17', local_date: '2026-10-17', local_start_time: '14:00', local_end_time: '15:00',
        venue_id: 1, room_id: 2, level_id: 3, activity_type_id: 4, contributors: [],
        venue: 'Palace', room: 'Grand Hall', address: 'Old Town', level: 'Open Level', activity_type: 'Workshop', attendee_note: null, is_cancelled: false, status: 'active',
    }],
};

describe('EventProgramExportPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fetchPublishedProgramExport).mockResolvedValue(program);
        vi.mocked(downloadPublishedProgramExport).mockResolvedValue({ blob: new Blob(['calendar']), filename: 'movida-2026-program.ics' });
        window.print = vi.fn();
    });

    it('applies the selected options to downloads and print preview', async () => {
        render(
            <MemoryRouter initialEntries={['/event/movida-2026/program/export']}>
                <Routes><Route path="/event/:eventId/program/export" element={<EventProgramExportPage />} /></Routes>
            </MemoryRouter>,
        );

        expect(await screen.findByRole('heading', { name: 'Movida 2026', level: 1 })).toBeInTheDocument();
        expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
        expect(screen.queryByText('Musicality with a long title that needs room to wrap')).not.toBeInTheDocument();
        const dayPill = screen.getByRole('button', { name: /Fri.*16|16.*Fri/ });
        expect(dayPill).toHaveAttribute('aria-pressed', 'true');
        expect(dayPill).not.toHaveTextContent(/Oct|2026/);
        expect(screen.getByTestId('program-export-scroll-region')).toHaveClass('overflow-y-auto');

        fireEvent.click(screen.getByRole('button', { name: 'Filter schedule' }));
        const sheet = screen.getByRole('dialog', { name: 'Filter schedule' });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Open Level' }));
        fireEvent.click(within(sheet).getByRole('button', { name: 'Workshop' }));
        fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Show cancelled sessions' }));
        fireEvent.click(within(sheet).getByRole('button', { name: 'Show 4 sessions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Download calendar (.ics)' }));

        await waitFor(() => expect(downloadPublishedProgramExport).toHaveBeenCalledWith('movida-2026', 'ics', {
            days: ['2026-10-16', '2026-10-17'],
            includeCancelled: true,
            instructor: '',
            levelIds: [3],
            activityTypeIds: [4],
        }));
        expect(saveDownload).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Preview PDF' }));
        const preview = screen.getByRole('dialog', { name: 'PDF preview' });
        const longTitle = within(preview).getByText('Musicality with a long title that needs room to wrap');
        expect(longTitle).toBeInTheDocument();
        expect(longTitle).toHaveClass('whitespace-normal');
        expect(within(preview).getByText('Maya and a long list of guest instructors')).toHaveClass('program-calendar-contributors', 'whitespace-normal', 'break-words');
        expect(within(preview).getAllByText('Open Level').some((element) => element.classList.contains('program-calendar-level-full'))).toBe(true);
        expect(within(preview).getAllByText('**').some((element) => element.classList.contains('program-calendar-level-compact'))).toBe(true);
        expect(within(preview).queryByText('(**)')).not.toBeInTheDocument();
        expect(within(preview).queryByText('Workshop')).not.toBeInTheDocument();
        expect(within(preview).getByText('Cancelled')).toBeInTheDocument();
        expect(within(preview).getByTestId('program-calendar-preview')).toHaveClass('overflow-auto');
        const calendarSheets = within(preview).getAllByTestId('program-calendar-sheet');
        expect(calendarSheets).toHaveLength(1);
        expect(within(calendarSheets[0]).getByTestId('program-calendar-2026-10-16')).toBeInTheDocument();
        expect(within(calendarSheets[0]).getByTestId('program-calendar-2026-10-17')).toBeInTheDocument();
        expect(within(calendarSheets[0]).getByTestId('program-calendar-day-separator-2026-10-17')).toHaveClass('border-l-2', 'border-line');
        expect(within(calendarSheets[0]).getByTestId('program-calendar-day-separator-2026-10-17')).not.toHaveClass('border-ink-soft');
        fireEvent.click(within(preview).getByRole('button', { name: 'Print / Save as PDF' }));
        expect(window.print).toHaveBeenCalled();
        fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
        expect(screen.queryByRole('dialog', { name: 'PDF preview' })).not.toBeInTheDocument();
    });
});
