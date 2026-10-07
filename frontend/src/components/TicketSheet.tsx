import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import useBackToClose from '../hooks/useBackToClose';
import useEventAssets from '../hooks/useEventAssets';
import type { CalendarEvent, EventUserAsset } from '../types';
import { TICKET_ACCEPT, formatAssetDate, linkHost } from '../utils/eventAssets';
import { ConfirmDialog, PromptDialog } from './AppDialog';
import EventAssetViewer from './EventAssetViewer';

interface Props {
    event: CalendarEvent;
    onClose: () => void;
}

const TILE = 'flex h-24 w-24 items-center justify-center overflow-hidden rounded-field border border-card-line bg-canvas';
const OPTION = 'flex min-h-12 w-full items-center gap-2 px-3 text-left text-sm text-ink transition hover:bg-canvas disabled:opacity-50';
// Hover-only devices reveal the delete badge on hover; touch devices always show it.
const DELETE_BADGE = 'absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-xs text-white transition hover:bg-danger [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100';

/** Ticket manager: bottom sheet on mobile, centered modal from `sm` up. */
export default function TicketSheet({ event, onClose }: Props) {
    const { data, error, busy, load, upload, addLink, remove, update } = useEventAssets(event.event_id, true);
    const [linkOpen, setLinkOpen] = useState(false);
    const [viewerIndex, setViewerIndex] = useState<number | null>(null);
    const [pendingDelete, setPendingDelete] = useState<EventUserAsset | null>(null);
    // Ticket count when "+" was opened; options auto-fold once a ticket is added or removed.
    const [addOpenAt, setAddOpenAt] = useState<number | null>(null);
    const cameraInput = useRef<HTMLInputElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const nestedOpen = linkOpen || viewerIndex !== null || pendingDelete !== null;

    useBackToClose(onClose, !nestedOpen);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = previousOverflow; };
    }, []);

    useEffect(() => {
        if (nestedOpen) return;
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [nestedOpen, onClose]);

    const [now] = useState(() => Date.now());
    const isPast = now >= new Date(event.end).getTime();
    const tickets = data ? data.assets.filter((a) => a.is_owner && a.kind !== 'memory') : [];
    const images = tickets.filter((t) => t.full_url);
    const hasTicket = tickets.length > 0;
    const canAdd = !isPast && Boolean(data?.can_add_ticket);
    const addOpen = addOpenAt !== null && addOpenAt === data?.ticket_count;
    const showOptions = canAdd && (!hasTicket || addOpen);

    const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        void upload(files, 'ticket');
    };

    const confirmDelete = async () => {
        if (!pendingDelete) return;
        const target = pendingDelete;
        setPendingDelete(null);
        setViewerIndex(null);
        await remove(target);
    };

    // Signed URLs expire; refresh when the viewer closes.
    const closeViewer = () => {
        setViewerIndex(null);
        load();
    };

    const body = !data ? (
        <p className="py-6 text-center text-sm text-ink-soft">Loading…</p>
    ) : !data.is_going ? (
        <p className="py-6 text-center text-sm text-ink-soft">Mark yourself as going to keep your ticket here.</p>
    ) : (
        <>
            {hasTicket && (
                <ul className="flex flex-wrap gap-3" aria-label="Saved tickets">
                    {tickets.map((asset) => (
                        <li key={asset.id} className="group relative">
                            {asset.full_url ? (
                                <button
                                    type="button"
                                    onClick={() => setViewerIndex(images.findIndex((t) => t.id === asset.id))}
                                    className={TILE}
                                    aria-label="Open ticket"
                                >
                                    {asset.thumb_url && <img src={asset.thumb_url} alt="" className="h-full w-full object-cover" />}
                                </button>
                            ) : (
                                <a
                                    href={asset.url ?? asset.file_url ?? '#'}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`${TILE} flex-col gap-1 px-2 text-center`}
                                >
                                    <span className="text-2xl" aria-hidden>{asset.kind === 'ticket_link' ? '🔗' : '📄'}</span>
                                    <span className="w-full truncate text-xs text-ink-soft">
                                        {asset.kind === 'ticket_link' ? linkHost(asset.url) : 'PDF ticket'}
                                    </span>
                                </a>
                            )}
                            <button
                                type="button"
                                onClick={() => setPendingDelete(asset)}
                                aria-label="Delete ticket"
                                className={DELETE_BADGE}
                            >
                                <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </li>
                    ))}
                    {canAdd && (
                        <li>
                            <button
                                type="button"
                                disabled={busy}
                                aria-expanded={addOpen}
                                aria-label="Add another ticket"
                                onClick={() => setAddOpenAt(addOpen ? null : data.ticket_count)}
                                className={`${TILE} flex-col gap-1 border-dashed text-xs text-ink-soft transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50 ${addOpen ? 'border-action text-action' : ''}`}
                            >
                                <span className="text-xl" aria-hidden>+</span>
                                Add
                            </button>
                        </li>
                    )}
                </ul>
            )}

            {!isPast && (
                data.can_add_ticket ? showOptions && (
                    <div className={`${hasTicket ? 'mt-4' : ''} divide-y divide-card-line border border-card-line`}>
                        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className={OPTION}>📄 Choose file (PDF, image)</button>
                        <button type="button" disabled={busy} onClick={() => setLinkOpen(true)} className={OPTION}>🔗 Paste ticket link</button>
                        <button type="button" disabled={busy} onClick={() => cameraInput.current?.click()} className={OPTION}>📷 Take a photo</button>
                    </div>
                ) : (
                    <p className="mt-3 text-xs text-ink-soft">Limit reached ({data.max_tickets}).</p>
                )
            )}
            {busy && <p className="mt-2 text-xs text-ink-soft">Uploading…</p>}

            <p className="mt-3 text-xs text-ink-soft">
                🔒 Only you can see this. Removed on {formatAssetDate(data.ticket_expires_at)}.
            </p>
            {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </>
    );

    return createPortal(
        <>
            <div
                className="fixed inset-0 z-[10600] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
                onClick={onClose}
            >
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="ticket-sheet-title"
                    onClick={(e) => e.stopPropagation()}
                    className="flex max-h-[85dvh] w-full flex-col rounded-t-card bg-surface shadow-2xl animate-slide-up sm:max-w-md sm:rounded-card"
                >
                    <header className="flex shrink-0 items-center gap-2 border-b border-card-line px-4 py-3">
                        <div className="min-w-0 flex-1">
                            <h2 id="ticket-sheet-title" className="text-base font-bold text-ink">🎟 My ticket</h2>
                            <p className="truncate text-sm text-ink-soft">{event.title}</p>
                        </div>
                        {data?.is_going && (
                            <span className="text-xs text-ink-soft tabular-nums">{data.ticket_count} / {data.max_tickets}</span>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close"
                            className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-canvas hover:text-ink sm:flex"
                        >
                            <X className="h-5 w-5" aria-hidden="true" />
                        </button>
                    </header>
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-4">
                        {body}
                    </div>
                </div>
            </div>

            <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
            <input ref={fileInput} type="file" accept={TICKET_ACCEPT} hidden onChange={onPick} />

            <PromptDialog
                open={linkOpen}
                title="Ticket link"
                message="Paste the https link from your ticket email."
                placeholder="https://"
                maxLength={1000}
                onConfirm={(url) => { setLinkOpen(false); void addLink(url); }}
                onCancel={() => setLinkOpen(false)}
            />

            <ConfirmDialog
                open={pendingDelete !== null}
                title="Delete ticket?"
                message="This can't be undone."
                confirmLabel="Delete"
                destructive
                onConfirm={confirmDelete}
                onCancel={() => setPendingDelete(null)}
            />

            {viewerIndex !== null && images.length > 0 && (
                <EventAssetViewer
                    assets={images}
                    initialIndex={Math.max(0, viewerIndex)}
                    onClose={closeViewer}
                    onDelete={setPendingDelete}
                    onUpdate={async (asset, change) => { await update(asset, change); }}
                />
            )}
        </>,
        document.body,
    );
}
