import { Link } from 'react-router-dom';
import { Repeat, ChevronRight } from 'lucide-react';

interface Props {
    title: string;
    /** Navigate to a route. */
    to?: string;
    /** Optional navigation callback, used to close an owning modal. */
    onClick?: () => void;
}

/**
 * One-line series row: repeat icon · "Series" · series name (blue) · chevron.
 * Shared by the event overview and the Details tab so both read identically.
 */
export default function SeriesRow({ title, to, onClick }: Props) {
    const inner = (
        <>
            <Repeat className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />
            <span className="shrink-0 text-ink-soft">Series</span>
            <span className="min-w-0 flex-1 truncate text-left font-medium text-action">{title}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        </>
    );
    const cls = 'flex w-full items-center gap-1.5 text-sm hover:underline';
    const label = `Open series ${title}`;

    if (to) {
        return <Link to={to} onClick={onClick} className={cls} aria-label={label}>{inner}</Link>;
    }
    return (
        <button type="button" onClick={onClick} className={cls} aria-label={label}>
            {inner}
        </button>
    );
}
