export interface HoverPopupController {
    /** Pointer entered the marker: open after the open delay. */
    enter: () => void;
    /** Pointer left the marker or card: close after the grace delay unless pinned. */
    leave: () => void;
    /** Pointer reached the open card: keep it open. */
    cancelClose: () => void;
    pin: () => void;
    isPinned: () => boolean;
    /** Card closed by any means: forget pin state and pending timers. */
    reset: () => void;
}

export function createHoverPopupController({ open, close, openDelayMs = 150, closeDelayMs = 250 }: {
    open: () => void;
    close: () => void;
    openDelayMs?: number;
    closeDelayMs?: number;
}): HoverPopupController {
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let pinned = false;

    const clearOpen = () => {
        clearTimeout(openTimer);
        openTimer = undefined;
    };
    const clearClose = () => {
        clearTimeout(closeTimer);
        closeTimer = undefined;
    };

    return {
        enter() {
            clearClose();
            if (pinned || openTimer) return;
            openTimer = setTimeout(() => {
                openTimer = undefined;
                open();
            }, openDelayMs);
        },
        leave() {
            clearOpen();
            if (pinned) return;
            clearClose();
            closeTimer = setTimeout(() => {
                closeTimer = undefined;
                close();
            }, closeDelayMs);
        },
        cancelClose: clearClose,
        pin() {
            pinned = true;
            clearOpen();
            clearClose();
        },
        isPinned: () => pinned,
        reset() {
            pinned = false;
            clearOpen();
            clearClose();
        },
    };
}
