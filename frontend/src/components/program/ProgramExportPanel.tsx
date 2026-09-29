import { useMemo, useState } from 'react';
import { CalendarDays, FileSpreadsheet, Printer } from 'lucide-react';
import { downloadPublishedProgramExport } from '../../api';
import type { EventSchedule, ProgramExport } from '../../types';
import { saveDownload } from '../../utils/download';
import { filterScheduleSessions, formatDayLabel, type ScheduleFilters } from '../../utils/schedule';
import { AttendeeProgramFilters } from './ProgramControls';
import ProgramExportPreviewModal from './ProgramExportPreviewModal';

const EMPTY_FILTERS: ScheduleFilters = { instructor: '', levelIds: [], activityTypeIds: [] };

interface Props {
    program: ProgramExport;
    eyebrow?: string;
    showCalendarDownloads?: boolean;
}

export default function ProgramExportPanel({ program, eyebrow, showCalendarDownloads = true }: Props) {
    const [selectedDays, setSelectedDays] = useState<string[]>(program.available_days);
    const [filters, setFilters] = useState<ScheduleFilters>(EMPTY_FILTERS);
    const [includeCancelled, setIncludeCancelled] = useState(false);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [busy, setBusy] = useState<'ics' | 'csv' | ''>('');
    const [error, setError] = useState<string | null>(null);
    const schedule = useMemo<EventSchedule>(() => ({
        event_id: program.event_id,
        timezone: program.timezone,
        day_start_hour: program.day_start_hour,
        days: program.available_days,
        venues: program.venues,
        rooms: program.rooms,
        levels: program.levels,
        activity_types: program.activity_types,
        contributors: program.contributors,
        sessions: program.sessions.map((session) => ({ ...session, allow_plan: true })),
        version: program.version,
        published_at: program.published_at,
    }), [program]);

    const visibleSessions = filterScheduleSessions(program.sessions, filters).filter((session) => (
        selectedDays.includes(session.program_day)
        && (includeCancelled || !session.is_cancelled)
    ));
    const disabled = selectedDays.length === 0 || visibleSessions.length === 0 || Boolean(busy);
    const toggleDay = (day: string) => setSelectedDays((current) => current.includes(day)
        ? current.filter((value) => value !== day)
        : program.available_days.filter((value) => current.includes(value) || value === day));
    const runDownload = async (format: 'ics' | 'csv') => {
        setBusy(format);
        setError(null);
        try {
            saveDownload(await downloadPublishedProgramExport(program.event_id, format, {
                days: selectedDays,
                includeCancelled,
                instructor: filters.instructor,
                ...(filters.contributorId == null ? {} : { contributorIds: [filters.contributorId] }),
                levelIds: filters.levelIds,
                activityTypeIds: filters.activityTypeIds,
            }));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Download failed');
        } finally {
            setBusy('');
        }
    };

    return (
        <section className="program-export-controls border-b border-line pb-6">
            <h2 className="text-lg font-bold">Export options</h2>
            <fieldset className="mt-4">
                <legend className="text-sm font-semibold">Program days</legend>
                <div className="mt-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {program.available_days.map((day) => (
                        <button key={day} type="button" aria-pressed={selectedDays.includes(day)} onClick={() => toggleDay(day)} className={`shrink-0 rounded-field border px-3 py-2 text-xs font-semibold ${selectedDays.includes(day) ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft'}`}>
                            {formatDayLabel(day)}
                        </button>
                    ))}
                </div>
            </fieldset>
            <AttendeeProgramFilters schedule={schedule} filters={filters} onChange={setFilters} cancelledFilter={{ value: includeCancelled, onChange: setIncludeCancelled }} />
            {selectedDays.length === 0 ? <p className="mt-3 text-sm text-danger">Select at least one program day.</p> : null}
            {selectedDays.length > 0 && visibleSessions.length === 0 ? <p className="mt-3 text-sm text-danger">No sessions match these filters.</p> : null}
            {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
            <div className="mt-5 flex flex-wrap gap-2">
                <button type="button" disabled={disabled} onClick={() => setPreviewOpen(true)} className="flex items-center gap-2 rounded-field bg-action px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><Printer size={17} />Preview PDF</button>
                {showCalendarDownloads ? <button type="button" disabled={disabled} onClick={() => runDownload('ics')} className="flex items-center gap-2 rounded-field border border-line bg-surface px-4 py-2.5 text-sm font-semibold disabled:opacity-50"><CalendarDays size={17} />{busy === 'ics' ? 'Downloading…' : 'Download calendar (.ics)'}</button> : null}
                {showCalendarDownloads ? <button type="button" disabled={disabled} onClick={() => runDownload('csv')} className="flex items-center gap-2 rounded-field border border-line bg-surface px-4 py-2.5 text-sm font-semibold disabled:opacity-50"><FileSpreadsheet size={17} />{busy === 'csv' ? 'Downloading…' : 'Download spreadsheet (.csv)'}</button> : null}
            </div>
            {previewOpen ? <ProgramExportPreviewModal program={program} days={selectedDays} sessions={visibleSessions} eyebrow={eyebrow} onClose={() => setPreviewOpen(false)} /> : null}
        </section>
    );
}
