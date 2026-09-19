import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

interface PromptDialogProps extends Omit<ConfirmDialogProps, 'onConfirm'> {
    initialValue?: string;
    placeholder?: string;
    maxLength?: number;
    onConfirm: (value: string) => void;
}

export function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
    busy = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    useDialogEscape(open, onCancel);
    if (!open) return null;
    return createPortal(
        <div className="fixed inset-0 z-[11000] flex items-center justify-center bg-slate-900/40 p-4" onClick={onCancel}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="app-dialog-title"
                className="w-full max-w-sm border border-line bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="border-b border-card-line px-4 py-3">
                    <h2 id="app-dialog-title" className="text-sm font-semibold text-ink">{title}</h2>
                </div>
                <div className="px-4 py-3">
                    <p className="whitespace-pre-line text-sm text-ink-soft">{message}</p>
                </div>
                <div className="flex justify-end gap-2 border-t border-card-line px-4 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={busy}
                        className="border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={busy}
                        className={destructive
                            ? 'bg-danger px-3 py-1.5 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50'
                            : 'bg-action px-3 py-1.5 text-sm font-medium text-white hover:bg-action disabled:opacity-50'}
                    >
                        {busy ? 'Working…' : confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

export function PromptDialog({
    open,
    title,
    message,
    initialValue = '',
    placeholder,
    maxLength,
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
    destructive = false,
    onConfirm,
    onCancel,
}: PromptDialogProps) {
    const [value, setValue] = useState(initialValue);
    useDialogEscape(open, onCancel);
    useEffect(() => {
        if (open) setValue(initialValue);
    }, [initialValue, open]);
    if (!open) return null;
    return createPortal(
        <div className="fixed inset-0 z-[11000] flex items-center justify-center bg-slate-900/40 p-4" onClick={onCancel}>
            <form
                role="dialog"
                aria-modal="true"
                aria-labelledby="app-prompt-title"
                className="w-full max-w-sm border border-line bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                    e.preventDefault();
                    onConfirm(value);
                }}
            >
                <div className="border-b border-card-line px-4 py-3">
                    <h2 id="app-prompt-title" className="text-sm font-semibold text-ink">{title}</h2>
                </div>
                <div className="space-y-3 px-4 py-3">
                    <p className="whitespace-pre-line text-sm text-ink-soft">{message}</p>
                    <input
                        type="text"
                        autoFocus
                        value={value}
                        maxLength={maxLength}
                        placeholder={placeholder}
                        onChange={(e) => setValue(e.target.value)}
                        className="w-full border border-line px-3 py-2 text-sm text-ink focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                    />
                </div>
                <div className="flex justify-end gap-2 border-t border-card-line px-4 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="submit"
                        className={destructive
                            ? 'bg-danger px-3 py-1.5 text-sm font-medium text-white hover:bg-danger/90'
                            : 'bg-action px-3 py-1.5 text-sm font-medium text-white hover:bg-action'}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </form>
        </div>,
        document.body,
    );
}

function useDialogEscape(open: boolean, onCancel: () => void) {
    useEffect(() => {
        if (!open) return;
        const handler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onCancel, open]);
}
