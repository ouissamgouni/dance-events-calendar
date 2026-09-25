import { useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, FileSpreadsheet, Printer } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { downloadPublishedProgramExport, fetchPublishedProgramExport } from '../api';
import type { ProgramExport } from '../types';
import { saveDownload } from '../utils/download';

export default function EventProgramExportPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const navigate = useNavigate();
    const [program, setProgram] = useState<ProgramExport | null>(null);
    const [selectedDays, setSelectedDays] = useState<string[]>([]);
    const [includeCancelled, setIncludeCancelled] = useState(true);
    const [busy, setBusy] = useState<'ics' | 'csv' | ''>('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!eventId) return;
        let cancelled = false;
        fetchPublishedProgramExport(eventId)
            .then((value) => {
                if (cancelled) return;
                setProgram(value);
                setSelectedDays(value.available_days);
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : 'Program export unavailable');
            });
        return () => { cancelled = true; };
    }, [eventId]);

    const runDownload = async (format: 'ics' | 'csv') => {
        if (!eventId) return;
        setBusy(format);
        setError(null);
        try {
            saveDownload(await downloadPublishedProgramExport(eventId, format, { days: selectedDays, includeCancelled }));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Download failed');
        } finally {
            setBusy('');
        }
    };

    if (error && !program) return <ExportState text={error} onBack={() => navigate(`/event/${eventId}/program`)} />;
    if (!program) return <ExportState text="Loading published program…" onBack={() => navigate(`/event/${eventId}/program`)} />;

    const visibleSessions = program.sessions.filter((session) => (
        selectedDays.includes(session.program_day)
        && (includeCancelled || session.status === 'active')
    ));
    const disabled = selectedDays.length === 0 || Boolean(busy);

    return (
        <div className="program-export-page min-h-full bg-canvas text-ink">
            <header className="program-export-controls border-b border-line bg-surface px-4 py-3">
                <div className="mx-auto flex max-w-4xl items-center gap-3">
                    <button type="button" onClick={() => navigate(`/event/${eventId}/program`)} aria-label="Back to program" className="flex h-11 w-11 items-center justify-center text-ink-soft"><ChevronLeft /></button>
                    <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold uppercase text-ink-soft">Published program export</p>
                        <h1 className="truncate text-lg font-bold">{program.event_title}</h1>
                    </div>
                </div>
            </header>

            <main className="mx-auto max-w-4xl px-4 py-6">
                <section className="program-export-controls border-b border-line pb-6">
                    <h2 className="text-lg font-bold">Export options</h2>
                    <fieldset className="mt-4">
                        <legend className="text-sm font-semibold">Program days</legend>
                        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-3">
                            {program.available_days.map((day) => (
                                <label key={day} className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={selectedDays.includes(day)}
                                        onChange={(event) => setSelectedDays((current) => event.target.checked ? [...current, day] : current.filter((value) => value !== day))}
                                    />
                                    {formatDay(day)}
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <label className="mt-4 flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={includeCancelled} onChange={(event) => setIncludeCancelled(event.target.checked)} />
                        Include cancelled sessions
                    </label>
                    {selectedDays.length === 0 ? <p className="mt-3 text-sm text-danger">Select at least one program day.</p> : null}
                    {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
                    <div className="mt-5 flex flex-wrap gap-2">
                        <button type="button" disabled={disabled} onClick={() => window.print()} className="flex items-center gap-2 rounded-field bg-action px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><Printer size={17} />Print / Save as PDF</button>
                        <button type="button" disabled={disabled} onClick={() => runDownload('ics')} className="flex items-center gap-2 rounded-field border border-line bg-surface px-4 py-2.5 text-sm font-semibold disabled:opacity-50"><CalendarDays size={17} />{busy === 'ics' ? 'Downloading…' : 'Download calendar (.ics)'}</button>
                        <button type="button" disabled={disabled} onClick={() => runDownload('csv')} className="flex items-center gap-2 rounded-field border border-line bg-surface px-4 py-2.5 text-sm font-semibold disabled:opacity-50"><FileSpreadsheet size={17} />{busy === 'csv' ? 'Downloading…' : 'Download spreadsheet (.csv)'}</button>
                    </div>
                </section>

                <article className="program-export-print mt-8 bg-surface p-6">
                    <header className="border-b border-ink pb-4">
                        <h2 className="text-2xl font-bold">{program.event_title}</h2>
                        <p className="mt-1 text-sm text-ink-soft">Published program · Version {program.version} · {program.timezone}</p>
                    </header>
                    {selectedDays.map((day) => {
                        const sessions = visibleSessions.filter((session) => session.program_day === day);
                        return <section key={day} className="mt-7">
                            <h3 className="text-lg font-bold">{formatDay(day)}</h3>
                            <div className="mt-2 divide-y divide-line border-y border-line">
                                {sessions.map((session) => (
                                    <section key={session.id} className="program-export-session grid gap-1 py-3 sm:grid-cols-[8rem_1fr] sm:gap-4">
                                        <p className="text-sm font-semibold">{session.local_start_time}–{session.local_end_time}</p>
                                        <div>
                                            <h4 className={`font-bold ${session.status !== 'active' ? 'line-through' : ''}`}>{session.title}</h4>
                                            {session.status !== 'active' ? <p className="text-sm font-semibold text-danger">Cancelled</p> : null}
                                            {session.instructors ? <p className="text-sm text-ink-soft">{session.instructors}</p> : null}
                                            <p className="text-sm text-ink-soft">{[session.activity_type, session.level, session.room, session.venue].filter(Boolean).join(' · ')}</p>
                                            {session.address ? <p className="text-sm text-ink-soft">{session.address}</p> : null}
                                            {session.attendee_note ? <p className="mt-1 text-sm">{session.attendee_note}</p> : null}
                                        </div>
                                    </section>
                                ))}
                                {!sessions.length ? <p className="py-3 text-sm text-ink-soft">No sessions selected.</p> : null}
                            </div>
                        </section>;
                    })}
                </article>
            </main>
        </div>
    );
}

function formatDay(day: string): string {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
}

function ExportState({ text, onBack }: { text: string; onBack: () => void }) {
    return <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-canvas p-6 text-center"><p className="font-semibold text-ink">{text}</p><button type="button" onClick={onBack} className="text-sm font-semibold text-action">Back to program</button></div>;
}
