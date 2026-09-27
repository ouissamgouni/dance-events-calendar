import { useEffect, useState } from 'react';
import { CalendarDays, Share2, Trash2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
    createMyPlanShare,
    downloadMyPlanIcs,
    fetchMyPlanShare,
    getMyPlanShareUrl,
    revokeMyPlanShare,
} from '../api';
import { saveDownload } from '../utils/download';
import ShareLinkRow from './ShareLinkRow';

interface MyPlanUtilityMenuProps {
    eventId: string;
}

export default function MyPlanUtilityMenu({ eventId }: MyPlanUtilityMenuProps) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState('');
    const [status, setStatus] = useState('');
    const [token, setToken] = useState<string | null>(null);
    const [tokenLoading, setTokenLoading] = useState(false);

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

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setTokenLoading(true);
        fetchMyPlanShare(eventId)
            .then((share) => {
                if (!cancelled) setToken(share?.token ?? null);
            })
            .catch(() => {
                if (!cancelled) setToken(null);
            })
            .finally(() => {
                if (!cancelled) setTokenLoading(false);
            });
        return () => { cancelled = true; };
    }, [eventId, open]);

    const sharePlan = async () => {
        setBusy('share');
        setStatus('');
        try {
            const share = await createMyPlanShare(eventId);
            setToken(share.token);
            const url = getMyPlanShareUrl(share.token);
            if (navigator.share) {
                await navigator.share({ title: 'My Movida Plan', url });
            } else {
                await navigator.clipboard.writeText(url);
                setStatus('Share link copied');
            }
        } catch (error) {
            if ((error as DOMException)?.name !== 'AbortError') {
                setStatus('Could not share My Plan');
            }
        } finally {
            setBusy('');
        }
    };

    const downloadPlan = async () => {
        setBusy('download');
        setStatus('');
        try {
            saveDownload(await downloadMyPlanIcs(eventId));
            setStatus('Downloaded');
        } catch {
            setStatus('Download failed');
        } finally {
            setBusy('');
        }
    };

    const stopSharing = async () => {
        setBusy('revoke');
        setStatus('');
        try {
            await revokeMyPlanShare(eventId);
            setToken(null);
            setStatus('Sharing stopped');
        } catch {
            setStatus('Could not stop sharing');
        } finally {
            setBusy('');
        }
    };

    const rowClass = 'flex w-full items-start gap-3 px-3 py-4 text-left hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50';
    const iconClass = 'inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card bg-canvas text-ink';
    const shareUrl = token ? getMyPlanShareUrl(token) : null;

    return (
        <>
            <button
                type="button"
                onClick={() => { setStatus(''); setOpen(true); }}
                aria-label="Share and export My Plan"
                aria-expanded={open}
                className="inline-flex items-center gap-2 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas"
            >
                <Share2 size={17} aria-hidden="true" />
                Share &amp; export
            </button>
            {open && createPortal(
                <div className="fixed inset-0 z-[11000] flex flex-col justify-end" role="presentation">
                    <button type="button" aria-label="Close Share and export" className="absolute inset-0 bg-slate-900/45" onClick={() => setOpen(false)} />
                    <section
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="my-plan-share-title"
                        className="relative z-10 mx-auto max-h-[88dvh] w-full max-w-xl overflow-y-auto rounded-t-card bg-surface px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-2 shadow-2xl"
                    >
                        <div className="mx-auto mb-2 h-1 w-14 rounded-card bg-line" aria-hidden="true" />
                        <div className="flex items-center justify-between py-2">
                            <h2 id="my-plan-share-title" className="text-xl font-bold text-ink">Share &amp; export My Plan</h2>
                            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="inline-flex h-10 w-10 items-center justify-center bg-canvas text-ink hover:text-action">
                                <X className="h-6 w-6" aria-hidden="true" />
                            </button>
                        </div>

                        <div className="mt-2 overflow-hidden rounded-card border border-line">
                            <button type="button" onClick={sharePlan} disabled={!!busy || tokenLoading} className={rowClass}>
                                <span className={`${iconClass} bg-blue-50 text-action`}><Share2 className="h-6 w-6" aria-hidden="true" /></span>
                                <span>
                                    <span className="block text-base font-semibold text-ink">Share My Plan</span>
                                    <span className="mt-1 block text-sm text-ink-soft">Send a live link to your festival schedule</span>
                                </span>
                            </button>
                            {shareUrl ? (
                                <div className="border-t border-line p-3">
                                    <ShareLinkRow
                                        url={shareUrl}
                                        onCopyClick={() => navigator.clipboard.writeText(shareUrl)}
                                        onShareClick={navigator.share ? () => navigator.share({ title: 'My Movida Plan', url: shareUrl }) : undefined}
                                        isBusy={!!busy}
                                        disabled={!!busy}
                                    />
                                    <button type="button" onClick={stopSharing} disabled={!!busy} className="mt-2 inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold text-danger disabled:opacity-50">
                                        <Trash2 size={16} aria-hidden="true" />
                                        Stop sharing
                                    </button>
                                </div>
                            ) : null}
                        </div>

                        <h3 className="mb-3 mt-6 text-base font-semibold text-ink">Export</h3>
                        <div className="overflow-hidden rounded-card border border-line">
                            <button type="button" onClick={downloadPlan} disabled={!!busy} className={rowClass}>
                                <span className={iconClass}><CalendarDays className="h-6 w-6" aria-hidden="true" /></span>
                                <span>
                                    <span className="block text-base font-semibold text-ink">Download calendar (.ics)</span>
                                    <span className="mt-1 block text-sm text-ink-soft">Add your plan to a calendar app</span>
                                </span>
                            </button>
                        </div>

                        {status ? <p className="mt-4 text-sm text-ink-soft" role="status">{status}</p> : null}
                        {busy || tokenLoading ? <p className="mt-2 text-sm text-muted">Working…</p> : null}
                    </section>
                </div>,
                document.body,
            )}
        </>
    );
}
