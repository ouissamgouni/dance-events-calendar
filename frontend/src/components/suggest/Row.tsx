import type { ComponentType, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { rowCls, rowErrorCls } from './formState';

interface Props {
    id?: string;
    icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;
    label: string;
    /** Right-aligned summary, e.g. `Every 2 weeks on Fri`. */
    value?: ReactNode;
    placeholder?: string;
    invalid?: boolean;
    describedBy?: string;
    onClick: () => void;
}

/** `icon · label · value · ›` navigation row that opens a sub-page. */
export default function Row({
    id,
    icon: Icon,
    label,
    value,
    placeholder,
    invalid,
    describedBy,
    onClick,
}: Props) {
    const text = value ?? placeholder ?? '';

    return (
        <button
            id={id}
            type="button"
            onClick={onClick}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className={invalid ? rowErrorCls : rowCls}
        >
            {Icon ? <Icon size={18} className="shrink-0 text-ink-soft" aria-hidden={true} /> : null}
            <span className="shrink-0 text-sm text-ink">{label}</span>
            <span className={`ml-auto min-w-0 truncate text-right text-sm ${value ? 'text-ink' : 'text-muted'}`}>
                {text}
            </span>
            <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden="true" />
        </button>
    );
}
