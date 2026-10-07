import type { EventAssetSummary, EventAssetVisibility } from '../types';

export const TICKET_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
export const MEMORY_ACCEPT = 'image/jpeg,image/png,image/webp';
export const TICKET_MAX_EDGE = 2400;
export const MEMORY_MAX_EDGE = 2048;
const MB = 1024 * 1024;

export const VISIBILITY_LABELS: Record<EventAssetVisibility, string> = {
    private: 'Only me',
    friends: 'Friends',
    attendees: 'People who went',
};

export const VISIBILITY_ICONS: Record<EventAssetVisibility, string> = {
    private: '🔒',
    friends: '👥',
    attendees: '🎉',
};

/** Client-side guard; the server re-checks type (by content) and size. */
export function assetFileError(
    file: { type: string; size: number },
    kind: 'ticket' | 'memory',
    maxMb: number,
): string | null {
    const accepted = (kind === 'ticket' ? TICKET_ACCEPT : MEMORY_ACCEPT).split(',');
    if (!accepted.includes(file.type)) {
        return kind === 'ticket'
            ? 'Only PDF, JPEG, PNG and WebP files are supported'
            : 'Memories must be JPEG, PNG or WebP images';
    }
    // Images are resized before upload, so only PDFs are held to the raw cap here.
    if (file.type === 'application/pdf' && file.size > maxMb * MB) {
        return `File is larger than ${maxMb}MB`;
    }
    return null;
}

/** Downscale an image to ``maxEdge`` (long side) as JPEG; non-images pass through. */
export async function prepareAssetUpload(file: File, kind: 'ticket' | 'memory'): Promise<{ blob: Blob; name: string }> {
    if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') {
        return { blob: file, name: file.name };
    }
    const maxEdge = kind === 'ticket' ? TICKET_MAX_EDGE : MEMORY_MAX_EDGE;
    // Ticket codes must stay scannable.
    const quality = kind === 'ticket' ? 0.92 : 0.85;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return { blob: file, name: file.name };
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return { blob: file, name: file.name };
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
}

export function memoryStrip(summary: EventAssetSummary | undefined, max = 3) {
    if (!summary) return { thumbs: [], extra: 0 };
    const thumbs = summary.memory_thumbs.slice(0, max);
    return { thumbs, extra: Math.max(0, summary.memory_count - thumbs.length) };
}

/** Memories row only shows when there are photos or uploads are still open. */
export function showMemoriesRow(summary: EventAssetSummary | undefined): boolean {
    return Boolean(summary && (summary.memory_count > 0 || summary.can_add_memory));
}

export function formatAssetDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function linkHost(url: string | null): string {
    if (!url) return '';
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}
