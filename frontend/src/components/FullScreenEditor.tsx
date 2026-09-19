import { useEffect } from 'react';

// FullScreenEditor — shared shell for a single filter dimension's editor,
// pushed over the FilterSheet as a full-screen screen (mobile) or a
// full-area modal overlay (desktop). Owns only the back/close chrome and an
// optional sticky footer CTA; the actual controls are passed as children so
// all filter state stays lifted in the parent (Home).
//
// Square corners, blue-500 primary, secondary slate chrome per
// .github/instructions/frontend.instructions.md.

export interface FullScreenEditorProps {
    title: string;
    /** Return to the section list. */
    onBack: () => void;
    /** Optional right-aligned header action (e.g. a "Clear" link). */
    headerAction?: React.ReactNode;
    /** Custom footer. When omitted, a default CTA (``ctaLabel``) is shown. */
    footer?: React.ReactNode;
    ctaLabel?: string;
    onCta?: () => void;
    ctaDisabled?: boolean;
    variant?: 'sheet' | 'modal';
    children: React.ReactNode;
}

export default function FullScreenEditor({
    title,
    onBack,
    headerAction,
    footer,
    ctaLabel,
    onCta,
    ctaDisabled = false,
    variant = 'sheet',
    children,
}: FullScreenEditorProps) {
    // Escape returns to the section list rather than closing the whole sheet,
    // matching the visible back affordance.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onBack();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onBack]);

    const backIcon = (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4 6 10l6 6" />
        </svg>
    );

    const defaultFooter = ctaLabel ? (
        <button
            type="button"
            onClick={onCta}
            disabled={ctaDisabled}
            className="inline-flex w-full items-center justify-center bg-action hover:bg-action text-white text-sm font-semibold px-3 py-2 shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="full-screen-editor-cta"
        >
            {ctaLabel}
        </button>
    ) : null;
    const footerContent = footer ?? defaultFooter;

    const panel = (
        <div
            className={
                variant === 'modal'
                    ? 'full-screen-editor-panel w-full max-w-2xl max-h-[min(85dvh,calc(100dvh-4rem))] bg-surface border border-line shadow-xl flex flex-col'
                    : 'full-screen-editor-panel bg-surface flex flex-col h-full'
            }
            data-testid="full-screen-editor"
        >
            <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-2">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1 text-sm font-semibold text-ink hover:text-action"
                    aria-label="Back to filters"
                    data-testid="full-screen-editor-back"
                >
                    {backIcon}
                    <span className="truncate">{title}</span>
                </button>
                {headerAction}
            </div>
            <div className="flex-1 overflow-y-auto bg-canvas px-3 py-3">
                {children}
            </div>
            {footerContent && (
                <div className="border-t border-line bg-canvas px-3 py-2">
                    {footerContent}
                </div>
            )}
        </div>
    );

    if (variant === 'modal') {
        return (
            <div
                className="absolute inset-0 z-[10] flex items-center justify-center bg-slate-900/40 p-4"
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <div className="w-full max-w-2xl">{panel}</div>
            </div>
        );
    }

    return (
        <div
            className="absolute inset-0 z-[10] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label={title}
        >
            {panel}
        </div>
    );
}
