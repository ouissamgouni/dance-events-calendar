/**
 * CalendarDetailDrawer — resizable right-side drawer with per-calendar details.
 *
 * Live polling drawer (3s when calendar is running). Body content is delegated
 * to <CalendarRunPanel>, which is the single source of truth for the detail
 * layout (also used by JobDetailDrawer.CalendarView).
 */
import { useEffect, useRef, useState } from 'react';
import type { CalendarStatus } from '../api';
import CalendarRunPanel from './CalendarRunPanel';

interface CalendarDetailDrawerProps {
    cal: CalendarStatus;
    jobStatus: string;
    onClose: () => void;
    /** Called to manually trigger a data refresh from parent */
    onRefresh: () => void;
}

const isActive = (s: string) => s === 'running' || s === 'abort_requested';

export default function CalendarDetailDrawer({
    cal,
    jobStatus,
    onClose,
    onRefresh,
}: CalendarDetailDrawerProps) {
    const [isPaused, setIsPaused] = useState(false);
    const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
    const [drawerWidth, setDrawerWidth] = useState<number>(() => {
        const stored = localStorage.getItem('calendarDetailDrawerWidth');
        return stored ? parseInt(stored, 10) : 900;
    });
    const isRunning = cal.status === 'running' && isActive(jobStatus);
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const resizingRef = useRef(false);

    // Poll when running and not paused
    useEffect(() => {
        if (!isRunning || isPaused) {
            if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
            return;
        }
        pollingRef.current = setInterval(() => {
            onRefresh();
            setLastUpdated(new Date());
        }, 3000);
        return () => {
            if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isRunning, isPaused]);

    // Persist width
    useEffect(() => {
        localStorage.setItem('calendarDetailDrawerWidth', String(drawerWidth));
    }, [drawerWidth]);

    // Resize handle drag
    const startResize = (e: React.MouseEvent) => {
        e.preventDefault();
        resizingRef.current = true;
        const startX = e.clientX;
        const startW = drawerWidth;

        const onMove = (ev: MouseEvent) => {
            if (!resizingRef.current) return;
            const delta = startX - ev.clientX;
            setDrawerWidth(Math.max(320, Math.min(1200, startW + delta)));
        };
        const onUp = () => {
            resizingRef.current = false;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    return (
        <>
            {/* Backdrop */}
            <div className="fixed inset-0 bg-black/10 z-40" onClick={onClose} />

            {/* Drawer */}
            <div
                className="fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-white shadow-2xl border-l border-gray-200"
                style={{ width: drawerWidth }}
            >
                {/* Resize handle */}
                <div
                    className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400 transition"
                    onMouseDown={startResize}
                />

                {/* Header */}
                <div className="flex-shrink-0 flex items-center justify-end px-4 py-2 border-b border-gray-100">
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1"
                        aria-label="Close"
                    >
                        ×
                    </button>
                </div>

                {/* Live control bar (running only) */}
                {isRunning && (
                    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 bg-blue-50 border-b border-blue-100">
                        <span className="text-[10px] text-blue-600">Live</span>
                        <button
                            onClick={() => setIsPaused((p) => !p)}
                            className="text-[10px] font-medium text-blue-700 hover:text-blue-900 px-1.5 py-0.5 border border-blue-200 rounded transition"
                        >
                            {isPaused ? 'Resume' : 'Pause'}
                        </button>
                        {isPaused && (
                            <button
                                onClick={() => { onRefresh(); setLastUpdated(new Date()); }}
                                className="text-[10px] font-medium text-blue-700 hover:text-blue-900 px-1.5 py-0.5 border border-blue-200 rounded transition"
                            >
                                Refresh
                            </button>
                        )}
                        <span className="ml-auto text-[10px] text-blue-500">
                            Updated {lastUpdated.toLocaleTimeString()}
                        </span>
                    </div>
                )}

                {/* Body — shared panel */}
                <div className="flex-1 overflow-y-auto">
                    <CalendarRunPanel cal={cal} jobStatus={jobStatus} />
                </div>
            </div>
        </>
    );
}
