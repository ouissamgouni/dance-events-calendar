import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import type { ProgramExport, ProgramExportSession } from '../../types';
import PrintableSchedule from './PrintableSchedule';
import useBackToClose from '../../hooks/useBackToClose';

interface Props {
    program: ProgramExport;
    days: string[];
    sessions: ProgramExportSession[];
    eyebrow?: string;
    onClose: () => void;
}

export default function ProgramExportPreviewModal({ program, days, sessions, eyebrow, onClose }: Props) {
    useBackToClose(onClose);
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onClose]);

    return createPortal(
        <div className="fixed inset-0 z-[11000] flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label="PDF preview">
            <header className="program-export-controls flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-3">
                <div className="min-w-0 flex-1">
                    <h2 className="truncate text-lg font-bold text-ink">PDF preview</h2>
                    <p className="text-xs text-ink-soft">{program.event_title} · {days.length} {days.length === 1 ? 'day' : 'days'}</p>
                </div>
                <button type="button" onClick={() => window.print()} className="flex min-h-11 items-center gap-2 rounded-field bg-action px-4 py-2.5 text-sm font-semibold text-white"><Printer size={17} />Print / Save as PDF</button>
                <button type="button" onClick={onClose} aria-label="Close preview" className="flex h-11 w-11 items-center justify-center text-ink-soft hover:bg-canvas"><X size={22} /></button>
            </header>
            <div className="program-export-print min-h-0 flex-1 overflow-auto p-4 sm:p-6" data-testid="program-calendar-preview">
                <div className="program-calendar-canvas mx-auto min-w-[1080px] max-w-[1280px]">
                    <PrintableSchedule program={program} days={days} sessions={sessions} eyebrow={eyebrow} />
                </div>
            </div>
        </div>,
        document.body,
    );
}
