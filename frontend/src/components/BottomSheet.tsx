import { useEffect, type ReactNode } from 'react';

interface Props {
    title: string;
    onClose: () => void;
    /** Sticky footer content, typically a primary confirm button. */
    footer?: ReactNode;
    children: ReactNode;
}

/**
 * Generic bottom sheet for compact selection/configuration tasks. Closes on
 * backdrop click and Escape, locks background scroll while open, and keeps its
 * footer clear of the iOS home indicator. The body scrolls independently so the
 * sheet never grows past 85% of the viewport height.
 */
export default function BottomSheet({ title, onClose, footer, children }: Props) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('keydown', onKey);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = previousOverflow;
        };
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/50 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[85dvh] w-full max-w-lg flex-col bg-surface shadow-2xl animate-slide-up sm:rounded-t-card"
            >
                <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
                    <h3 className="text-base font-bold text-ink">{title}</h3>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="-mr-2 flex h-11 w-11 items-center justify-center text-muted transition hover:bg-canvas hover:text-ink-soft"
                    >
                        ✕
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

                {footer ? (
                    <div className="shrink-0 border-t border-line px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
                        {footer}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
