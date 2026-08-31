import { Link } from 'react-router-dom';
import { Repeat, ChevronRight } from 'lucide-react';

interface Props {
    title: string;
    /** Navigate to a route (Details tab usage). */
    to?: string;
    /** Or run a handler (overview usage — scroll to the series section). */
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
            <span aria-hidden="true" className="shrink-0 text-muted">·</span>
            <span className="min-w-0 flex-1 truncate font-medium text-action">{title}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        </>
    );
    const cls = 'flex w-full items-center gap-1.5 text-sm hover:underline';

    if (to) {
        return <Link to={to} className={cls}>{inner}</Link>;
    }
    return (
        <button type="button" onClick={onClick} className={cls}>
            {inner}
        </button>
    );
}
