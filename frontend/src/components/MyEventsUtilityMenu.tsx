import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CalendarPlus, FileSpreadsheet, Share2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { createShareToken, exportIcs, exportXlsx, getCalendarFeedUrl } from '../api';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { getDeviceId } from '../utils/deviceId';

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
    const eventIds = useMemo(() => [...new Set([...savedEventIds, ...attendingEventIds])], [savedEventIds, attendingEventIds]);

    useEffect(() => {
        if (!open) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', onKeyDown);
        };
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

    const subscribe = async () => {
        setBusy('feed');
        setStatus('');
        try {
            const { token } = await createShareToken(getDeviceId());
            await navigator.clipboard.writeText(getCalendarFeedUrl(token, 'all'));
            setStatus('Calendar subscription link copied');
        } catch {
            setStatus('Could not create feed');
        } finally {
            setBusy('');
        }
    };

    const rowClass = 'flex w-full items-start gap-3 px-3 py-4 text-left hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50';
    const iconClass = 'inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card bg-canvas text-ink';
    return (
        <>
            <button
                type="button"
                onClick={() => { setStatus(''); setOpen(true); }}
                aria-label="Share and export My Events"
                aria-expanded={open}
                className="inline-flex h-10 w-10 items-center justify-center text-ink hover:text-action"
            >
                <Share2 className="h-6 w-6" aria-hidden="true" />
            </button>
            {open && createPortal(
                <div className="fixed inset-0 z-[11000] flex flex-col justify-end" role="presentation">
                    <button type="button" aria-label="Close Share and export" className="absolute inset-0 bg-slate-900/45" onClick={() => setOpen(false)} />
                    <section
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="my-events-share-title"
                        className="relative z-10 mx-auto max-h-[88dvh] w-full max-w-xl overflow-y-auto rounded-t-card bg-surface px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-2 shadow-2xl"
                    >
                        <div className="mx-auto mb-2 h-1 w-14 rounded-full bg-line" aria-hidden="true" />
                        <div className="flex items-center justify-between py-2">
                            <h2 id="my-events-share-title" className="text-xl font-bold text-ink">Share &amp; export</h2>
                            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-canvas text-ink hover:text-action">
                                <X className="h-6 w-6" aria-hidden="true" />
                            </button>
                        </div>

                        <div className="mt-2 overflow-hidden rounded-card border border-line">
                            <button type="button" onClick={share} disabled={!!busy} className={rowClass}>
                                <span className={`${iconClass} bg-blue-50 text-action`}><Share2 className="h-6 w-6" aria-hidden="true" /></span>
                                <span>
                                    <span className="block text-base font-semibold text-ink">Share My Events</span>
                                    <span className="mt-1 block text-sm text-ink-soft">Send a Movida link to your calendar</span>
                                </span>
                            </button>
                            <button type="button" onClick={subscribe} disabled={!!busy} className={`${rowClass} border-t border-line`}>
                                <span className={iconClass}><CalendarPlus className="h-6 w-6" aria-hidden="true" /></span>
                                <span>
                                    <span className="block text-base font-semibold text-ink">Subscribe in another calendar</span>
                                    <span className="mt-1 block text-sm text-ink-soft">Keep your Movida events synced with your calendar. Copy the link and add it using Subscribe or Add from URL.</span>
                                </span>
                            </button>
                        </div>

                        <h3 className="mb-3 mt-6 text-base font-semibold text-ink">Export</h3>
                        <div className="overflow-hidden rounded-card border border-line">
                            <button type="button" onClick={() => runDownload('ics')} disabled={!!busy || eventIds.length === 0} className={rowClass}>
                                <span className={iconClass}><CalendarDays className="h-6 w-6" aria-hidden="true" /></span>
                                <span>
                                    <span className="block text-base font-semibold text-ink">Export calendar (.ics)</span>
                                    <span className="mt-1 block text-sm text-ink-soft">Download for calendar apps</span>
                                </span>
                            </button>
                            <button type="button" onClick={() => runDownload('xlsx')} disabled={!!busy || eventIds.length === 0} className={`${rowClass} border-t border-line`}>
                                <span className={iconClass}><FileSpreadsheet className="h-6 w-6" aria-hidden="true" /></span>
                                <span>
                                    <span className="block text-base font-semibold text-ink">Export spreadsheet (.xlsx)</span>
                                    <span className="mt-1 block text-sm text-ink-soft">Download your events as a spreadsheet</span>
                                </span>
                            </button>
                        </div>

                        {status && <p className="mt-4 text-sm text-ink-soft" role="status">{status}</p>}
                        {busy && <p className="mt-2 text-sm text-muted">Working…</p>}
                    </section>
                </div>,
                document.body,
            )}
        </>
    );
}
