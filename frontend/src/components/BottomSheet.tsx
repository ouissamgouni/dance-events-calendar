import { useEffect, type ReactNode } from 'react';

interface Props {
    title: string;
    subtitle?: string;
    titleSize?: 'default' | 'large' | 'xl';
    onClose: () => void;
    layer?: 'modal' | 'transient';
    /** ``floating`` = inset card with rounded corners and a drag handle. */
    variant?: 'default' | 'floating';
    headerLeading?: ReactNode;
    headerAction?: ReactNode;
    showClose?: boolean;
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
export default function BottomSheet({ title, subtitle, titleSize = 'default', onClose, layer = 'modal', variant = 'default', headerLeading, headerAction, showClose = true, footer, children }: Props) {
    const floating = variant === 'floating';
    const titleClass = titleSize === 'xl' ? 'text-2xl' : titleSize === 'large' ? 'text-lg' : 'text-base';
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
            className={`fixed inset-0 flex items-end justify-center bg-black/50 animate-fade-in ${floating ? 'px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]' : ''} ${layer === 'transient' ? 'z-[12000]' : 'z-[10000]'}`}
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(e) => e.stopPropagation()}
                className={`flex max-h-[85dvh] w-full max-w-lg flex-col bg-surface shadow-2xl animate-slide-up ${floating ? 'overflow-hidden rounded-card' : 'sm:rounded-t-card'}`}
            >
                {floating ? (
                    <div className="flex shrink-0 justify-center pt-2" aria-hidden>
                        {/* eslint-disable-next-line no-restricted-syntax -- drag handle is a pill by design */}
                        <span className="h-1 w-10 rounded-full bg-line" />
                    </div>
                ) : null}
                <div className={`flex shrink-0 justify-between border-b border-line px-4 ${floating ? 'items-start pt-2 pb-4' : 'items-center py-3'}`}>
                    <div className={`flex min-w-0 items-start ${floating ? 'gap-3' : 'gap-2'}`}>
                        {headerLeading}
                        <div className="min-w-0">
                            <h3 className={`${titleClass} font-bold text-ink`}>{title}</h3>
                            {subtitle ? (
                                <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-ink-soft">{subtitle}</p>
                            ) : null}
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        {headerAction}
                        {showClose ? (
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Close"
                                className="-mr-2 flex h-11 w-11 items-center justify-center text-muted transition hover:bg-canvas hover:text-ink-soft"
                            >
                                ✕
                            </button>
                        ) : null}
                    </div>
                </div>

                <div className={`min-h-0 flex-1 overflow-y-auto px-4 ${floating ? 'py-4' : 'py-3'}`}>{children}</div>

                {footer ? (
                    <div className={`shrink-0 border-t border-line px-4 ${floating ? 'py-3' : 'pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]'}`}>
                        {footer}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
