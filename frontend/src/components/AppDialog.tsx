import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
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
                className="w-full max-w-sm border border-slate-200 bg-white shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="border-b border-slate-100 px-4 py-3">
                    <h2 id="app-dialog-title" className="text-sm font-semibold text-slate-900">{title}</h2>
                </div>
                <div className="px-4 py-3">
                    <p className="whitespace-pre-line text-sm text-slate-600">{message}</p>
                </div>
                <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className={destructive
                            ? 'bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700'
                            : 'bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600'}
                    >
                        {confirmLabel}
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
                className="w-full max-w-sm border border-slate-200 bg-white shadow-xl"
                onClick={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                    e.preventDefault();
                    onConfirm(value);
                }}
            >
                <div className="border-b border-slate-100 px-4 py-3">
                    <h2 id="app-prompt-title" className="text-sm font-semibold text-slate-900">{title}</h2>
                </div>
                <div className="space-y-3 px-4 py-3">
                    <p className="whitespace-pre-line text-sm text-slate-600">{message}</p>
                    <input
                        type="text"
                        autoFocus
                        value={value}
                        maxLength={maxLength}
                        placeholder={placeholder}
                        onChange={(e) => setValue(e.target.value)}
                        className="w-full border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                </div>
                <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                        {cancelLabel}
                    </button>
                    <button type="submit" className="bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600">
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
