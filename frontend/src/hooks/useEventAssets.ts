import { useCallback, useEffect, useState } from 'react';
import {
    addEventTicketLink,
    deleteEventAsset,
    fetchEventAssets,
    setTicketNotNeeded,
    updateEventAsset,
    uploadEventAsset,
} from '../api';
import { usePatchEventAssetSummary } from '../context/EventAssetSummaryContext';
import type { EventAssets, EventAssetVisibility, EventUserAsset } from '../types';
import { assetFileError, prepareAssetUpload } from '../utils/eventAssets';

export type UploadKind = 'ticket' | 'memory';

const MB = 1024 * 1024;
// Mirrors backend event_assets.SUMMARY_THUMBS.
const SUMMARY_THUMBS = 3;

/** Loads and mutates the viewer's tickets/memories for one event. */
export default function useEventAssets(eventId: string, enabled: boolean) {
    const [data, setData] = useState<EventAssets | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
        if (!enabled) return;
        fetchEventAssets(eventId).then(setData).catch(() => setData(null));
    }, [enabled, eventId]);

    useEffect(load, [load]);

    const patchSummary = usePatchEventAssetSummary();
    useEffect(() => {
        if (!data?.is_going) return;
        patchSummary(data.event_id, {
            ticket_count: data.ticket_count,
            memory_count: data.memory_count,
            ticket_likely: data.ticket_likely,
            ticket_not_needed: data.ticket_not_needed,
            can_add_memory: data.can_add_memory,
            memory_window_closes_at: data.memory_window_closes_at,
            memory_thumbs: data.assets
                .filter((a) => a.is_owner && a.kind === 'memory')
                .slice(0, SUMMARY_THUMBS)
                .map((a) => ({ id: a.id, thumb_url: a.thumb_url, visibility: a.visibility })),
            shared_memory_count: data.assets.filter((a) => !a.is_owner && a.kind === 'memory').length,
        });
    }, [data, patchSummary]);

    const run = useCallback(async (action: () => Promise<EventAssets>, fallback: string) => {
        setError(null);
        try {
            const next = await action();
            setData(next);
            return next;
        } catch (e) {
            setError(e instanceof Error ? e.message : fallback);
            return null;
        }
    }, []);

    const upload = useCallback(async (picked: File[], kind: UploadKind, visibility?: EventAssetVisibility) => {
        if (!data) return;
        const remaining = kind === 'ticket'
            ? data.max_tickets - data.ticket_count
            : data.max_memories - data.memory_count;
        const files = picked.slice(0, Math.max(0, remaining));
        if (!files.length) return;
        const maxMb = kind === 'ticket' ? data.max_ticket_mb : data.max_memory_mb;
        setError(null);
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
                setData(await uploadEventAsset(eventId, kind, blob, name, kind === 'memory' ? visibility : undefined));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Upload failed');
        } finally {
            setBusy(false);
        }
    }, [data, eventId]);

    const addLink = useCallback(async (url: string) => {
        setBusy(true);
        try {
            await run(() => addEventTicketLink(eventId, url.trim()), 'Could not save the link');
        } finally {
            setBusy(false);
        }
    }, [eventId, run]);

    const remove = useCallback(
        (asset: EventUserAsset) => run(() => deleteEventAsset(asset.id), 'Could not delete the file'),
        [run],
    );

    const update = useCallback(
        (asset: EventUserAsset, change: Parameters<typeof updateEventAsset>[1]) =>
            run(() => updateEventAsset(asset.id, change), 'Could not save'),
        [run],
    );

    const setNotNeeded = useCallback(
        (notNeeded: boolean) => run(() => setTicketNotNeeded(eventId, notNeeded), 'Could not save'),
        [eventId, run],
    );

    return { data, error, busy, load, upload, addLink, remove, update, setNotNeeded };
}
