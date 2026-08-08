/**
 * Turn the off-screen Dance Passport card into a PNG and hand it to the user.
 *
 * We render at the card's CSS size (360×640) and upscale via `pixelRatio: 3`
 * to produce a 1080×1920 Story-sized image. Leaflet maps can't be captured
 * (cross-origin tiles taint the canvas), which is why the card draws its own
 * inline-SVG map instead.
 */
import { toBlob } from 'html-to-image';

export const CARD_WIDTH = 360;
export const CARD_HEIGHT = 640;

export async function renderCardToBlob(node: HTMLElement): Promise<Blob> {
    const blob = await toBlob(node, {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        pixelRatio: 3,
        cacheBust: true,
        backgroundColor: '#0f172a', // slate-900, matches the card
    });
    if (!blob) throw new Error('Could not render the passport image.');
    return blob;
}

export type ShareResult = 'shared' | 'cancelled' | 'unsupported';

/**
 * Offer the image to the native share sheet (with a file).
 * - `'shared'` — the OS share sheet handled it.
 * - `'cancelled'` — the user dismissed the sheet (stay silent).
 * - `'unsupported'` — no file-level Web Share here; caller falls back to
 *   {@link downloadImage}.
 */
export async function shareImage(
    blob: Blob,
    filename: string,
    meta?: { title?: string; text?: string },
): Promise<ShareResult> {
    const file = new File([blob], filename, { type: 'image/png' });
    const nav = navigator as Navigator & {
        canShare?: (data: ShareData) => boolean;
    };
    if (typeof nav.share !== 'function' || !nav.canShare?.({ files: [file] })) {
        return 'unsupported';
    }
    try {
        await nav.share({ files: [file], title: meta?.title, text: meta?.text });
        return 'shared';
    } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
        return 'unsupported';
    }
}

/** Save the PNG directly — always available, regardless of Web Share support. */
export function downloadImage(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
