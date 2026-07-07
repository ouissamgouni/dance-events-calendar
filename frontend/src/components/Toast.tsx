import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
    label: string;
    onClick: () => void;
}

export interface ToastInput {
    title: string;
    message?: string;
    variant?: ToastVariant;
    duration?: number; // ms; default 6000. Pass 0 for sticky.
    action?: ToastAction;
}

interface Toast extends ToastInput {
    id: number;
}

interface ToastContextValue {
    push: (toast: ToastInput) => number;
    dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Record<ToastVariant, string> = {
    info: 'bg-white border-slate-200 text-slate-900',
    success: 'bg-white border-emerald-200 text-slate-900',
    warning: 'bg-white border-amber-200 text-slate-900',
    error: 'bg-white border-rose-200 text-slate-900',
};

const VARIANT_DOT: Record<ToastVariant, string> = {
    info: 'bg-slate-400',
    success: 'bg-emerald-500',
    warning: 'bg-amber-500',
    error: 'bg-rose-500',
};

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const idRef = useRef(0);
    const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        const timer = timersRef.current.get(id);
        if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(id);
        }
    }, []);

    const push = useCallback(
        (input: ToastInput) => {
            const id = ++idRef.current;
            const toast: Toast = { id, variant: 'info', duration: 6000, ...input };
            setToasts((prev) => [...prev, toast]);
            const duration = toast.duration ?? 6000;
            if (duration > 0) {
                const timer = setTimeout(() => dismiss(id), duration);
                timersRef.current.set(id, timer);
            }
            return id;
        },
        [dismiss],
    );

    useEffect(() => {
        return () => {
            timersRef.current.forEach((t) => clearTimeout(t));
            timersRef.current.clear();
        };
    }, []);

    return (
        <ToastContext.Provider value={{ push, dismiss }}>
            {children}
            <div className="fixed bottom-4 right-4 z-[12000] flex flex-col gap-2 w-full sm:w-80 max-w-[calc(100vw-2rem)]">
                {toasts.map((t) => {
                    const variant = t.variant ?? 'info';
                    return (
                        <div
                            key={t.id}
                            className={`pointer-events-auto border shadow-lg px-3 py-2 text-sm flex gap-2 ${VARIANT_STYLES[variant]}`}
                            role="status"
                        >
                            <span className={`mt-1.5 inline-block w-2 h-2 rounded-full flex-shrink-0 ${VARIANT_DOT[variant]}`} />
                            <div className="flex-1 min-w-0">
                                <div className="font-medium leading-tight">{t.title}</div>
                                {t.message && (
                                    <div className="text-slate-600 text-xs mt-0.5 break-words">{t.message}</div>
                                )}
                                {t.action && (
                                    <button
                                        onClick={() => {
                                            t.action!.onClick();
                                            dismiss(t.id);
                                        }}
                                        className="mt-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
                                    >
                                        {t.action.label}
                                    </button>
                                )}
                            </div>
                            <button
                                onClick={() => dismiss(t.id)}
                                aria-label="Dismiss"
                                className="text-slate-400 hover:text-slate-600 -mr-1 -mt-0.5 text-base leading-none"
                            >
                                ×
                            </button>
                        </div>
                    );
                })}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        // Safe no-op fallback so unwrapped components don't crash.
        return {
            push: () => 0,
            dismiss: () => { },
        };
    }
    return ctx;
}
