import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { exportIcs, exportXlsx } from '../api';
import { trackExportAction } from '../utils/tracking';

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export default function SavedEventsFab() {
    const { savedCount, savedEventIds } = useSavedEvents();
    const { attendingCount, attendingEventIds } = useAttendingEvents();
    const [open, setOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();

    // Deduped union for exports
    const allEventIds = useMemo(
        () => [...new Set([...savedEventIds, ...attendingEventIds])],
        [savedEventIds, attendingEventIds],
    );
    const allCount = allEventIds.length;

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    // Close on Escape
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open]);

    const handleExport = useCallback(async (format: 'ics' | 'xlsx') => {
        if (allEventIds.length === 0) return;
        setExporting(true);
        try {
            const blob = format === 'ics'
                ? await exportIcs(allEventIds)
                : await exportXlsx(allEventIds);
            downloadBlob(blob, `my-movida-events.${format}`);
            trackExportAction(format, allEventIds.length);
        } catch {
            // silently fail
        } finally {
            setExporting(false);
            setOpen(false);
        }
    }, [allEventIds]);

    if (allCount === 0) return null;

    return (
        <div ref={menuRef} className="relative">
            {/* Bookmarks button */}
            <button
                onClick={() => setOpen((v) => !v)}
                className={`flex items-center gap-1.5 px-2 py-1 text-sm transition ${open
                    ? 'bg-white text-slate-900 font-medium shadow-sm'
                    : 'bg-white text-slate-900 font-medium shadow-sm hover:bg-slate-50'
                    }`}
                aria-label={`My Events: ${attendingCount} going, ${savedCount} saved`}
            >
                <span className="hidden sm:inline font-medium">My Events</span>
                {attendingCount > 0 && (
                    <span className="flex items-center gap-0.5 text-emerald-600 font-medium">
                        {/* Heroicons hand-raised solid */}
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M10.5 1.875C10.5 1.25368 11.0037 0.75 11.625 0.75C12.2463 0.75 12.75 1.25368 12.75 1.875V10.0938C13.2674 10.2561 13.7708 10.4757 14.25 10.7527V3.375C14.25 2.75368 14.7537 2.25 15.375 2.25C15.9963 2.25 16.5 2.75368 16.5 3.375V14.3122C15.0821 14.5501 13.8891 15.451 13.2506 16.6852C14.4554 16.0866 15.8134 15.75 17.25 15.75C17.6642 15.75 18 15.4142 18 15V12.75L18 12.7336C18.0042 11.8771 18.3339 11.0181 18.9885 10.3635C19.4278 9.92417 20.1402 9.92417 20.5795 10.3635C21.0188 10.8028 21.0188 11.5152 20.5795 11.9545C20.361 12.173 20.2514 12.4567 20.25 12.7445L20.25 12.75L20.25 15.75H20.2454C20.1863 17.2558 19.5623 18.6877 18.4926 19.7574L16.7574 21.4926C15.6321 22.6179 14.106 23.25 12.5147 23.25H10.5C6.35786 23.25 3 19.8921 3 15.75V6.375C3 5.75368 3.50368 5.25 4.125 5.25C4.74632 5.25 5.25 5.75368 5.25 6.375V11.8939C5.71078 11.4421 6.2154 11.0617 6.75 10.7527V3.375C6.75 2.75368 7.25368 2.25 7.875 2.25C8.49632 2.25 9 2.75368 9 3.375V9.90069C9.49455 9.80023 9.99728 9.75 10.5 9.75V1.875Z" />
                        </svg>
                        {attendingCount}
                    </span>
                )}
                {attendingCount > 0 && savedCount > 0 && (
                    <span className="text-slate-300 text-xs">·</span>
                )}
                {savedCount > 0 && (
                    <span className="flex items-center gap-0.5 text-slate-600 font-medium">
                        {/* Heroicons bookmark solid */}
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                        </svg>
                        {savedCount}
                    </span>
                )}
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 transition-transform text-slate-400 ${open ? 'rotate-180' : ''}`}>
                    <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                </svg>
            </button>

            {/* Dropdown menu */}
            {open && (
                <div className="absolute top-10 right-0 w-40 bg-white rounded-md shadow-xl border border-slate-200 py-0.5 z-[9000]">
                    <button
                        onClick={() => { navigate('/my-calendar'); setOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 transition"
                    >
                        Open My Calendar
                    </button>
                    <div className="border-t border-slate-100" />
                    <button
                        onClick={() => handleExport('ics')}
                        disabled={exporting}
                        className="w-full text-left px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 transition disabled:opacity-50"
                    >
                        Export .ics
                    </button>
                    <button
                        onClick={() => handleExport('xlsx')}
                        disabled={exporting}
                        className="w-full text-left px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 transition disabled:opacity-50"
                    >
                        Export .xlsx
                    </button>
                </div>
            )}
        </div>
    );
}
