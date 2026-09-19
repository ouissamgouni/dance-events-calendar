import { useEffect, type ReactNode } from 'react';
import { ChevronLeft, X } from 'lucide-react';

interface Props {
    title: string;
    onBack: () => void;
    /** `close` for a surface opened from a row, `back` for one pushed onto another. */
    backIcon?: 'back' | 'close';
    /** Sticky footer, typically the single `Done`/`Save` action. */
    footer?: ReactNode;
    children: ReactNode;
}

/**
 * A wizard sub-editor rendered as a full-screen page over the current step.
 *
 * It covers the wizard's own header and footer, which is the point: `Submit
 * Event` must be unreachable — and absent from the DOM — while a sub-editor is
 * open, and every sub-editor confirms with `Done`/`Save` instead.
 */
export default function SubPage({ title, onBack, backIcon = 'close', footer, children }: Props) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onBack();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onBack]);

    const Icon = backIcon === 'back' ? ChevronLeft : X;

    return (
        <section
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="absolute inset-0 z-10 flex flex-col bg-surface sm:rounded-card"
        >
            <header className="flex shrink-0 items-center gap-2 px-4 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 sm:pt-2">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label={backIcon === 'back' ? 'Back' : 'Close'}
                    className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft transition hover:text-ink"
                >
                    <Icon size={20} aria-hidden="true" />
                </button>
                <h2 className="min-w-0 flex-1 truncate text-base font-bold text-ink">{title}</h2>
                <span className="h-11 w-11 shrink-0" aria-hidden="true" />
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">{children}</div>

            {footer ? (
                <div className="shrink-0 bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                    {footer}
                </div>
            ) : null}
        </section>
    );
}
