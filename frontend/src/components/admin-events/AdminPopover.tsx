import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
    open: boolean;
    onClose: () => void;
    label: string;
    align?: 'left' | 'right';
    className?: string;
    children: ReactNode;
}

/** Anchored below its `relative` wrapper; the wrapper should also hold the trigger. */
export default function AdminPopover({ open, onClose, label, align = 'left', className = '', children }: Props) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const wrapper = ref.current?.parentElement;
        const onPointerDown = (e: PointerEvent) => {
            if (wrapper && !wrapper.contains(e.target as Node)) onClose();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose();
            wrapper?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open, onClose]);

    if (!open) return null;
    return (
        <div
            ref={ref}
            role="dialog"
            aria-label={label}
            className={`absolute top-full z-30 mt-1 border border-line bg-surface p-2 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'} ${className}`}
        >
            {children}
        </div>
    );
}
