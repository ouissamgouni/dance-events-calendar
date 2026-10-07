import type { MouseEvent } from 'react';

/** Plain left-click (no modifier) — modified clicks keep native link behaviour (new tab etc.). */
export function isPlainClick(e: MouseEvent): boolean {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
