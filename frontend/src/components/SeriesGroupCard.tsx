import type { SeriesGroup } from '../types';

interface Props {
    group: SeriesGroup;
    acting?: boolean;
    onApprove?: () => void;
    onDismiss?: () => void;
    onRemove?: (eventId: string) => void;
    onOpenEvent?: (eventId: string) => void;
}

function statusBadge(status: string) {
    const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        resolved: 'bg-emerald-100 text-success',
        dismissed: 'bg-slate-200 text-ink',
    };
    return (
        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${colors[status] ?? 'bg-gray-100 text-ink-soft'}`}>
            {status}
        </span>
    );
}

export default function SeriesGroupCard({ group, acting, onApprove, onDismiss, onRemove, onOpenEvent }: Props) {
    return (
        <div>
            <div className="flex items-center gap-2 flex-wrap mb-2">
                {statusBadge(group.status)}
                <span className="text-[10px] uppercase text-muted">{group.source}</span>
                <span className="font-medium text-xs text-ink">{group.canonical_title}</span>
                <span className="text-[10px] text-muted">
                    {new Date(group.created_at).toLocaleString()}
                </span>
            </div>
            <ul className="space-y-1.5">
                {group.events.map((ev) => (
                    <li
                        key={ev.event_id}
                        className="flex items-start justify-between gap-3 border border-card-line bg-canvas px-2 py-1.5"
                    >
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                {onOpenEvent ? (
                                    <button
                                        type="button"
                                        onClick={() => onOpenEvent(ev.event_id)}
                                        className="font-medium text-action hover:underline text-left text-xs"
                                    >
                                        {ev.title}
                                    </button>
                                ) : (
                                    <span className="font-medium text-xs">{ev.title}</span>
                                )}
                            </div>
                            <div className="mt-0.5 text-[10px] text-ink-soft">
                                {new Date(ev.start).toLocaleString()} — {ev.event_id}
                            </div>
                        </div>
                        {onRemove && (
                            <button
                                disabled={acting}
                                onClick={() => onRemove(ev.event_id)}
                                className="text-[11px] text-ink-soft hover:text-ink px-2 py-1 disabled:opacity-50 shrink-0"
                            >
                                Remove
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {group.status === 'pending' && (onApprove || onDismiss) && (
                <div className="mt-2 flex items-center gap-2">
                    {onApprove && (
                        <button
                            disabled={acting}
                            onClick={onApprove}
                            className="text-[11px] bg-action text-white px-2 py-1 hover:bg-action disabled:opacity-50"
                        >
                            Approve series
                        </button>
                    )}
                    {onDismiss && (
                        <button
                            disabled={acting}
                            onClick={onDismiss}
                            className="text-[11px] text-ink-soft hover:text-ink px-2 py-1 disabled:opacity-50"
                        >
                            Not a series — dismiss
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
