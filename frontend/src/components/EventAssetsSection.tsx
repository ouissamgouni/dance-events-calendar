import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
    addEventTicketLink,
    deleteEventAsset,
    fetchEventAssets,
    setTicketNotNeeded,
    updateEventAsset,
    uploadEventAsset,
} from '../api';
import { useAuth } from '../context/AuthContext';
import { usePatchEventAssetSummary } from '../context/EventAssetSummaryContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type { CalendarEvent, EventAssets, EventUserAsset } from '../types';
import {
    MEMORY_ACCEPT,
    TICKET_ACCEPT,
    VISIBILITY_ICONS,
    assetFileError,
    formatAssetDate,
    linkHost,
    prepareAssetUpload,
} from '../utils/eventAssets';
import BottomSheet from './BottomSheet';
import { ConfirmDialog, PromptDialog } from './AppDialog';
import EventAssetViewer from './EventAssetViewer';

interface Props {
    event: CalendarEvent;
    isPast: boolean;
}

type UploadKind = 'ticket' | 'memory';

const MB = 1024 * 1024;
const TILE = 'relative flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-field border border-card-line bg-canvas text-left';

export default function EventAssetsSection({ event, isPast }: Props) {
    const { user } = useAuth();
    const { eventTicketsEnabled, eventMemoriesEnabled } = useFeatureFlags();
    const [data, setData] = useState<EventAssets | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [ticketSheetOpen, setTicketSheetOpen] = useState(false);
    const [linkOpen, setLinkOpen] = useState(false);
    const [viewer, setViewer] = useState<{ assets: EventUserAsset[]; index: number } | null>(null);
    const [pendingDelete, setPendingDelete] = useState<EventUserAsset | null>(null);
    const cameraInput = useRef<HTMLInputElement>(null);
    const ticketInput = useRef<HTMLInputElement>(null);
    const memoryInput = useRef<HTMLInputElement>(null);

    const enabled = Boolean(user) && (eventTicketsEnabled || eventMemoriesEnabled);

    const load = useCallback(() => {
        if (!enabled) return;
        fetchEventAssets(event.event_id).then(setData).catch(() => setData(null));
    }, [enabled, event.event_id]);

    useEffect(load, [load]);

    const { hash } = useLocation();
    useEffect(() => {
        if (!data) return;
        const id = hash.slice(1);
        if (id === 'ticket' || id === 'memories') {
            requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        }
    }, [data, hash]);

    const patchSummary = usePatchEventAssetSummary();
    useEffect(() => {
        if (!data?.is_going) return;
        patchSummary(data.event_id, {
            ticket_count: data.ticket_count,
            memory_count: data.memory_count,
            ticket_likely: data.ticket_likely,
            ticket_not_needed: data.ticket_not_needed,
        });
    }, [data, patchSummary]);

    // Signed URLs expire; refresh the list when the viewer closes.
    const closeViewer = useCallback(() => {
        setViewer(null);
        load();
    }, [load]);

    if (!enabled || !data) return null;

    const tickets = data.assets.filter((a) => a.is_owner && a.kind !== 'memory');
    const memories = data.assets.filter((a) => a.kind === 'memory');
    const showTickets = eventTicketsEnabled && data.is_going && (!isPast || tickets.length > 0);
    // can_add_memory already implies the event has started.
    const showMemories = eventMemoriesEnabled && (memories.length > 0 || data.can_add_memory);
    if (!showTickets && !showMemories) return null;

    const runUpload = async (files: File[], kind: UploadKind) => {
        setError(null);
        const maxMb = kind === 'ticket' ? data.max_ticket_mb : data.max_memory_mb;
        setBusy(true);
        try {
            for (const file of files) {
                const invalid = assetFileError(file, kind, maxMb);
                if (invalid) {
                    setError(invalid);
                    return;
                }
                const { blob, name } = await prepareAssetUpload(file, kind);
                if (blob.size > maxMb * MB) {
                    setError(`File is larger than ${maxMb}MB`);
                    return;
                }
                setData(await uploadEventAsset(event.event_id, kind, blob, name));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Upload failed');
        } finally {
            setBusy(false);
        }
    };

    const onPick = (kind: UploadKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        setTicketSheetOpen(false);
        const remaining = kind === 'ticket'
            ? data.max_tickets - data.ticket_count
            : data.max_memories - data.memory_count;
        if (files.length) void runUpload(files.slice(0, Math.max(0, remaining)), kind);
    };

    const saveLink = async (url: string) => {
        setLinkOpen(false);
        setError(null);
        setBusy(true);
        try {
            setData(await addEventTicketLink(event.event_id, url.trim()));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save the link');
        } finally {
            setBusy(false);
        }
    };

    const confirmDelete = async () => {
        if (!pendingDelete) return;
        const target = pendingDelete;
        setPendingDelete(null);
        setViewer(null);
        try {
            setData(await deleteEventAsset(target.id));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not delete the file');
        }
    };

    const update = async (asset: EventUserAsset, change: Parameters<typeof updateEventAsset>[1]) => {
        try {
            const next = await updateEventAsset(asset.id, change);
            setData(next);
            setViewer((v) => v && {
                ...v,
                assets: next.assets.filter((a) => (asset.kind === 'memory' ? a.kind === 'memory' : a.is_owner && a.kind !== 'memory')),
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save');
        }
    };

    const openTicket = (asset: EventUserAsset) => {
        const images = tickets.filter((t) => t.full_url);
        setViewer({ assets: images, index: Math.max(0, images.findIndex((t) => t.id === asset.id)) });
    };

    const toggleNotNeeded = async (notNeeded: boolean) => {
        setError(null);
        try {
            setData(await setTicketNotNeeded(event.event_id, notNeeded));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save');
        }
    };

    // Only events that usually need an advance ticket get the full prompt.
    const ticketPrompt = !isPast && tickets.length === 0
        ? (data.ticket_likely ? (data.ticket_not_needed ? 'dismissed' : 'full') : 'quiet')
        : null;

    const ticketSection = ticketPrompt === 'dismissed' ? (
        <section id="ticket" aria-label="My ticket" className="text-xs text-ink-soft">
            🎟 No ticket needed ·{' '}
            <button type="button" onClick={() => toggleNotNeeded(false)} className="font-medium text-action hover:underline">
                Undo
            </button>
        </section>
    ) : ticketPrompt === 'quiet' ? (
        <section id="ticket" aria-label="My ticket">
            <button
                type="button"
                disabled={!data.can_add_ticket || busy}
                onClick={() => setTicketSheetOpen(true)}
                className="text-xs font-medium text-action hover:underline disabled:opacity-50"
            >
                {busy ? 'Uploading…' : '🎟 Add ticket'}
            </button>
        </section>
    ) : null;

    return (
        <div className="mb-6 space-y-6">
            {showTickets && ticketSection}
            {showTickets && !ticketSection && (
                <section id="ticket" aria-labelledby="my-ticket-title">
                    <div className="flex items-baseline justify-between">
                        <h2 id="my-ticket-title" className="text-lg font-semibold text-ink">🎟 My ticket</h2>
                        <span className="text-xs text-ink-soft tabular-nums">{data.ticket_count} / {data.max_tickets}</span>
                    </div>
                    <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
                        {tickets.map((asset) => {
                            if (asset.kind === 'ticket_link' || asset.file_url) {
                                return (
                                    <div key={asset.id} className="relative shrink-0">
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
                                        <button
                                            type="button"
                                            onClick={() => setPendingDelete(asset)}
                                            aria-label="Delete ticket"
                                            className="absolute top-0 right-0 flex h-7 w-7 items-center justify-center text-xs text-ink-soft hover:text-danger"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                );
                            }
                            return (
                                <button key={asset.id} type="button" onClick={() => openTicket(asset)} className={TILE} aria-label="Open ticket">
                                    {asset.thumb_url && <img src={asset.thumb_url} alt="" className="h-full w-full object-cover" />}
                                </button>
                            );
                        })}
                        {!isPast && (
                            <button
                                type="button"
                                disabled={!data.can_add_ticket || busy}
                                onClick={() => setTicketSheetOpen(true)}
                                className={`${TILE} flex-col gap-1 border-dashed text-center text-xs text-ink-soft disabled:cursor-not-allowed disabled:opacity-50 ${tickets.length ? '' : 'w-full max-w-xs'}`}
                            >
                                <span className="text-xl" aria-hidden>+</span>
                                {busy ? 'Uploading…' : data.can_add_ticket
                                    ? (tickets.length ? 'Add' : 'Add your ticket: PDF, screenshot or link')
                                    : `Limit reached (${data.max_tickets})`}
                            </button>
                        )}
                    </div>
                    <p className="mt-2 text-xs text-ink-soft">
                        🔒 Only you can see this. Removed on {formatAssetDate(data.ticket_expires_at)}.
                    </p>
                    {ticketPrompt === 'full' && (
                        <button
                            type="button"
                            onClick={() => toggleNotNeeded(true)}
                            className="mt-1 text-xs font-medium text-ink-soft hover:text-ink hover:underline"
                        >
                            No ticket needed
                        </button>
                    )}
                </section>
            )}

            {showMemories && (
                <section id="memories" aria-labelledby="memories-title">
                    <div className="flex items-baseline justify-between">
                        <h2 id="memories-title" className="text-lg font-semibold text-ink">📸 Memories</h2>
                        {data.is_going && (
                            <span className="text-xs text-ink-soft tabular-nums">{data.memory_count} / {data.max_memories}</span>
                        )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3">
                        {memories.map((asset, index) => (
                            <button
                                key={asset.id}
                                type="button"
                                onClick={() => setViewer({ assets: memories, index })}
                                className={TILE}
                                aria-label={asset.caption ?? `Memory ${index + 1}`}
                            >
                                {asset.thumb_url && <img src={asset.thumb_url} alt="" className="h-full w-full object-cover" />}
                                <span className="absolute right-1 bottom-1 bg-surface/90 px-1 text-xs" aria-hidden>
                                    {asset.is_owner ? VISIBILITY_ICONS[asset.visibility] : '👤'}
                                </span>
                            </button>
                        ))}
                        {data.is_going && data.can_add_memory && (
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => memoryInput.current?.click()}
                                className={`${TILE} flex-col gap-1 border-dashed text-xs text-ink-soft disabled:cursor-not-allowed disabled:opacity-50`}
                            >
                                <span className="text-xl" aria-hidden>+</span>
                                {busy ? 'Uploading…' : 'Add'}
                            </button>
                        )}
                    </div>
                    {data.is_going && (
                        <p className="mt-2 text-xs text-ink-soft">
                            {data.can_add_memory
                                ? `Add memories until ${formatAssetDate(data.memory_window_closes_at)}.`
                                : data.memory_count >= data.max_memories
                                    ? `Limit reached (${data.max_memories}).`
                                    : 'Upload window closed.'}
                        </p>
                    )}
                </section>
            )}

            {error && <p role="alert" className="text-sm text-danger">{error}</p>}

            <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onPick('ticket')} />
            <input ref={ticketInput} type="file" accept={TICKET_ACCEPT} hidden onChange={onPick('ticket')} />
            <input ref={memoryInput} type="file" accept={MEMORY_ACCEPT} multiple hidden onChange={onPick('memory')} />

            {ticketSheetOpen && (
                <BottomSheet title="Add ticket" onClose={() => setTicketSheetOpen(false)}>
                    <div className="flex flex-col">
                        <button type="button" onClick={() => cameraInput.current?.click()} className="min-h-12 px-2 text-left text-sm text-ink hover:bg-canvas">📷 Take a photo</button>
                        <button type="button" onClick={() => ticketInput.current?.click()} className="min-h-12 px-2 text-left text-sm text-ink hover:bg-canvas">📄 Choose file (PDF, image)</button>
                        <button type="button" onClick={() => { setTicketSheetOpen(false); setLinkOpen(true); }} className="min-h-12 px-2 text-left text-sm text-ink hover:bg-canvas">🔗 Paste ticket link</button>
                    </div>
                </BottomSheet>
            )}

            <PromptDialog
                open={linkOpen}
                title="Ticket link"
                message="Paste the https link from your ticket email."
                placeholder="https://"
                maxLength={1000}
                onConfirm={saveLink}
                onCancel={() => setLinkOpen(false)}
            />

            <ConfirmDialog
                open={pendingDelete !== null}
                title="Delete file?"
                message="This can't be undone."
                confirmLabel="Delete"
                destructive
                onConfirm={confirmDelete}
                onCancel={() => setPendingDelete(null)}
            />

            {viewer && viewer.assets.length > 0 && (
                <EventAssetViewer
                    assets={viewer.assets}
                    initialIndex={viewer.index}
                    onClose={closeViewer}
                    onDelete={setPendingDelete}
                    onUpdate={update}
                />
            )}
        </div>
    );
}
