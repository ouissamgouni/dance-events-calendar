import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadPublishedProgramExport, fetchPublishedProgramExport } from '../api';
import { saveDownload } from '../utils/download';
import EventProgramExportPage from './EventProgramExportPage';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return { ...actual, downloadPublishedProgramExport: vi.fn(), fetchPublishedProgramExport: vi.fn() };
});
vi.mock('../utils/download', () => ({ saveDownload: vi.fn() }));

const program = {
    event_id: 'movida-2026',
    event_title: 'Movida 2026',
    program_url: 'https://example.test/event/movida-2026/program',
    timezone: 'Europe/Prague',
    day_start_hour: 6,
    available_days: ['2026-10-16'],
    selected_days: ['2026-10-16'],
    version: 2,
    published_at: '2026-09-01T12:00:00Z',
    sessions: [{
        id: 'session-1', title: 'Musicality', instructors: 'Maya', start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z',
        program_day: '2026-10-16', local_date: '2026-10-16', local_start_time: '14:00', local_end_time: '15:00',
        venue: 'Palace', room: 'Grand Hall', address: 'Old Town', level: 'Open', activity_type: 'Workshop', attendee_note: null, status: 'cancelled' as const,
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
        expect(screen.getByText('Cancelled')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('checkbox', { name: 'Include cancelled sessions' }));
        expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Download calendar (.ics)' }));

        await waitFor(() => expect(downloadPublishedProgramExport).toHaveBeenCalledWith('movida-2026', 'ics', {
            days: ['2026-10-16'],
            includeCancelled: false,
        }));
        expect(saveDownload).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
        expect(window.print).toHaveBeenCalled();
    });
});
