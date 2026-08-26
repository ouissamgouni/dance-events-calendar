import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarPlus, Download, MoreHorizontal, Share2, Users } from 'lucide-react';
import { createShareToken, exportIcs, exportXlsx, getCalendarFeedUrl } from '../api';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { getDeviceId } from '../utils/deviceId';
import MySubscribersBadge from './MySubscribersBadge';

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

export default function MyEventsUtilityMenu() {
    const { savedEventIds } = useSavedEvents();
    const { attendingEventIds } = useAttendingEvents();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState('');
    const [status, setStatus] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const eventIds = useMemo(() => [...new Set([...savedEventIds, ...attendingEventIds])], [savedEventIds, attendingEventIds]);

    useEffect(() => {
        if (!open) return;
        const close = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const runDownload = async (kind: 'ics' | 'xlsx') => {
        if (eventIds.length === 0) return;
        setBusy(kind);
        setStatus('');
        try {
            const blob = kind === 'ics' ? await exportIcs(eventIds) : await exportXlsx(eventIds);
            downloadBlob(blob, `my-movida-events.${kind}`);
            setStatus('Downloaded');
        } catch {
            setStatus('Download failed');
        } finally {
            setBusy('');
        }
    };

    const share = async () => {
        setBusy('share');
        setStatus('');
        try {
            const { token } = await createShareToken(getDeviceId());
            const url = `${window.location.origin}/shared/${token}`;
            if (navigator.share) {
                await navigator.share({ title: 'My Movida Calendar', url });
            } else {
                await navigator.clipboard.writeText(url);
                setStatus('Share link copied');
            }
        } catch (error) {
            if ((error as DOMException)?.name !== 'AbortError') setStatus('Could not share');
        } finally {
            setBusy('');
        }
    };

    const copyFeed = async () => {
        setBusy('feed');
        setStatus('');
        try {
            const { token } = await createShareToken(getDeviceId());
            await navigator.clipboard.writeText(getCalendarFeedUrl(token, 'all'));
            setStatus('Calendar feed copied');
        } catch {
            setStatus('Could not create feed');
        } finally {
            setBusy('');
        }
    };

    const itemClass = 'flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink hover:bg-canvas disabled:opacity-50';
    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-label="My Events options"
                aria-expanded={open}
                className="inline-flex h-9 w-9 items-center justify-center text-ink-soft hover:text-action"
            >
                <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            </button>
            {open && (
                <div className="absolute right-0 top-full z-[8000] mt-1 w-56 border border-line bg-surface py-1 shadow-lg">
                    <button type="button" onClick={() => runDownload('ics')} disabled={!!busy || eventIds.length === 0} className={itemClass}>
                        <CalendarPlus className="h-4 w-4" aria-hidden="true" /> Export .ics
                    </button>
                    <button type="button" onClick={() => runDownload('xlsx')} disabled={!!busy || eventIds.length === 0} className={itemClass}>
                        <Download className="h-4 w-4" aria-hidden="true" /> Export .xlsx
                    </button>
                    <button type="button" onClick={share} disabled={!!busy} className={itemClass}>
                        <Share2 className="h-4 w-4" aria-hidden="true" /> Share calendar
                    </button>
                    <button type="button" onClick={copyFeed} disabled={!!busy} className={itemClass}>
                        <CalendarPlus className="h-4 w-4" aria-hidden="true" /> Copy calendar feed
                    </button>
                    <div className="border-t border-card-line px-3 py-2">
                        <MySubscribersBadge mobileIconSrc="/rss.png" className="flex items-center gap-2 text-xs text-ink hover:text-action" />
                    </div>
                    {status && <p className="border-t border-card-line px-3 py-2 text-[11px] text-ink-soft" role="status">{status}</p>}
                    {busy && <p className="border-t border-card-line px-3 py-2 text-[11px] text-muted"><Users className="mr-1 inline h-3 w-3" />Working…</p>}
                </div>
            )}
        </div>
    );
}
