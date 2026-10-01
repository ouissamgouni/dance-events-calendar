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
    /** Optional secondary button shown left of the default CTA. */
    secondaryLabel?: string;
    onSecondary?: () => void;
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
    secondaryLabel,
    onSecondary,
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
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4 6 10l6 6" />
        </svg>
    );

    const ctaButton = ctaLabel ? (
        <button
            type="button"
            onClick={onCta}
            disabled={ctaDisabled}
            className="inline-flex min-h-11 w-full items-center justify-center bg-action hover:opacity-90 text-white text-sm font-semibold px-4 shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="full-screen-editor-cta"
        >
            {ctaLabel}
        </button>
    ) : null;
    const defaultFooter = ctaButton && secondaryLabel ? (
        <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={onSecondary}
                className="inline-flex min-h-11 shrink-0 items-center justify-center border border-line bg-surface text-ink hover:bg-canvas text-sm font-semibold px-4 transition"
                data-testid="full-screen-editor-secondary"
            >
                {secondaryLabel}
            </button>
            <div className="flex-1">{ctaButton}</div>
        </div>
    ) : ctaButton;
    const footerContent = footer ?? defaultFooter;

    const panel = (
        <div
            className={
                variant === 'modal'
                    ? 'full-screen-editor-panel w-full max-w-2xl max-h-[min(85dvh,calc(100dvh-4rem))] bg-surface border border-line shadow-xl flex flex-col'
                    : 'full-screen-editor-panel bg-surface flex min-h-0 flex-1 flex-col'
            }
            data-testid="full-screen-editor"
        >
            <div className="flex min-h-14 items-center justify-between gap-2 border-b border-line px-2 py-1">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex min-h-11 items-center gap-1.5 px-2 text-base font-semibold text-ink hover:text-action"
                    aria-label="Back to filters"
                    data-testid="full-screen-editor-back"
                >
                    {backIcon}
                    <span className="truncate">{title}</span>
                </button>
                {headerAction}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-4 py-4">
                {children}
            </div>
            {footerContent && (
                <div className="border-t border-line bg-canvas px-4 py-3">
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

    // Sheet variant renders in-flow; FilterSheet sizes the panel around it.
    return (
        <div
            className="flex min-h-0 flex-1 flex-col"
            role="dialog"
            aria-modal="true"
            aria-label={title}
        >
            {panel}
        </div>
    );
}
