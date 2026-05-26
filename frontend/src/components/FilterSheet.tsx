import { useEffect } from 'react';

// FilterSheet — mobile-only bottom sheet that consolidates the explorer's
// filter controls into a single overlay so the landing page isn't
// dominated by a tall filter stack. Controls live in the parent so all
// state stays lifted; this component only owns the open/close chrome.
//
// Square corners, blue-500 primary, secondary slate chrome per
// .github/instructions/frontend.instructions.md.

export interface FilterSheetProps {
    open: boolean;
    onClose: () => void;
    onClearAll?: () => void;
    activeFilterCount: number;
    matchingEventCount: number;
    children: React.ReactNode;
}

export default function FilterSheet({
    open,
    onClose,
    onClearAll,
    activeFilterCount,
    matchingEventCount,
    children,
}: FilterSheetProps) {
    // Lock body scroll while open and close on Escape. Pointer-target = the
    // backdrop, which already calls onClose; this only covers the keyboard
    // path.
    useEffect(() => {
        if (!open) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = previous;
            window.removeEventListener('keydown', onKey);
        };
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[8500] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label="Filters"
            data-testid="filter-sheet"
        >
            {/* Backdrop — tap to dismiss. Uses bg-slate-900/60 instead of an
                opacity utility on the backdrop to avoid bleeding into the
                sheet content. */}
            <button
                type="button"
                aria-label="Close filters"
                onClick={onClose}
                className="flex-1 bg-slate-900/60"
            />
            <div className="filter-sheet-panel bg-white border-t border-slate-200 shadow-xl flex flex-col">
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                    <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold text-slate-800">Filters</h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close filters"
                        className="inline-flex h-7 w-7 items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100"
                    >
                        ×
                    </button>
                </div>
                <div className="filter-sheet-body flex-1 overflow-y-auto bg-slate-50 px-3 py-2 flex flex-col gap-2">
                    {children}
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2">
                    <button
                        type="button"
                        onClick={onClearAll}
                        disabled={!onClearAll || activeFilterCount === 0}
                        className="text-xs text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:no-underline"
                        data-testid="filter-sheet-clear-all"
                    >
                        Clear all
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex items-center bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold px-3 py-1.5 shadow-sm transition"
                        data-testid="filter-sheet-apply"
                    >
                        {matchingEventCount === 0
                            ? 'No matches — close'
                            : `Show ${matchingEventCount} event${matchingEventCount === 1 ? '' : 's'}`}
                    </button>
                </div>
            </div>
        </div>
    );
}
