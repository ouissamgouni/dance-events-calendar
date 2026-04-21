import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSavedEvents } from '../context/SavedEventsContext';
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
    const [open, setOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();

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
        if (savedEventIds.length === 0) return;
        setExporting(true);
        try {
            const blob = format === 'ics'
                ? await exportIcs(savedEventIds)
                : await exportXlsx(savedEventIds);
            downloadBlob(blob, `my-movida-events.${format}`);
            trackExportAction(format, savedEventIds.length);
        } catch {
            // silently fail
        } finally {
            setExporting(false);
            setOpen(false);
        }
    }, [savedEventIds]);

    if (savedCount === 0) return null;

    return (
        <div ref={menuRef} className="relative">
            {/* Bookmarks button */}
            <button
                onClick={() => setOpen((v) => !v)}
                className={`flex items-center gap-1 px-2 py-1 text-sm transition ${open
                    ? 'bg-white text-slate-900 font-medium shadow-sm'
                    : 'bg-white text-slate-900 font-medium shadow-sm hover:bg-slate-50'
                    }`}
                aria-label={`Bookmarks: ${savedCount} events saved`}
            >
                <span className="font-medium">Saved</span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                </svg>
                <span className="font-medium">{savedCount}</span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}>
                    <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                </svg>
            </button>

            {/* Dropdown menu */}
            {open && (
                <div className="absolute top-10 right-0 w-36 bg-white rounded-md shadow-xl border border-slate-200 py-0.5 z-[9000]">
                    <button
                        onClick={() => { navigate('/my-calendar'); setOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 transition"
                    >
                        View saved
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
