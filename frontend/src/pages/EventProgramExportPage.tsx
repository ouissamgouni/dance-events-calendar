import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchPublishedProgramExport } from '../api';
import ProgramExportPanel from '../components/program/ProgramExportPanel';
import type { ProgramExport } from '../types';

export default function EventProgramExportPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const navigate = useNavigate();
    const [program, setProgram] = useState<ProgramExport | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!eventId) return;
        let cancelled = false;
        fetchPublishedProgramExport(eventId)
            .then((value) => {
                if (cancelled) return;
                setProgram(value);
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : 'Program export unavailable');
            });
        return () => { cancelled = true; };
    }, [eventId]);

    if (error && !program) return <ExportState text={error} onBack={() => navigate(`/event/${eventId}/program`)} />;
    if (!program) return <ExportState text="Loading published program…" onBack={() => navigate(`/event/${eventId}/program`)} />;

    return (
        <div className="program-export-page flex h-full min-h-0 flex-col bg-canvas text-ink">
            <header className="program-export-controls shrink-0 border-b border-line bg-surface px-4 py-3">
                <div className="mx-auto flex max-w-4xl items-center gap-3">
                    <button type="button" onClick={() => navigate(`/event/${eventId}/program`)} aria-label="Back to program" className="flex h-11 w-11 items-center justify-center text-ink-soft"><ChevronLeft /></button>
                    <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold uppercase text-ink-soft">Published program export</p>
                        <h1 className="truncate text-lg font-bold">{program.event_title}</h1>
                    </div>
                </div>
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto" data-testid="program-export-scroll-region">
                <div className="mx-auto max-w-6xl px-4 py-6">
                    <ProgramExportPanel program={program} />
                </div>
            </main>
        </div>
    );
}

function ExportState({ text, onBack }: { text: string; onBack: () => void }) {
    return <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-canvas p-6 text-center"><p className="font-semibold text-ink">{text}</p><button type="button" onClick={onBack} className="text-sm font-semibold text-action">Back to program</button></div>;
}
