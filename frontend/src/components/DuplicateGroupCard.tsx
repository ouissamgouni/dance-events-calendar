import type { DuplicateGroup } from '../types';

interface Props {
    group: DuplicateGroup;
    acting?: boolean;
    onKeep: (eventId: string) => void;
    onDismiss: () => void;
    onOpenEvent?: (eventId: string) => void;
}

function statusBadge(status: string) {
    const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        resolved: 'bg-emerald-100 text-emerald-700',
        dismissed: 'bg-slate-200 text-slate-700',
    };
    return (
        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
            {status}
        </span>
    );
}

export default function DuplicateGroupCard({ group, acting, onKeep, onDismiss, onOpenEvent }: Props) {
    return (
        <div>
            <div className="flex items-center gap-2 flex-wrap mb-2">
                {statusBadge(group.status)}
                <span className="text-[10px] uppercase text-slate-400">{group.source}</span>
                <span className="text-[10px] text-slate-400">
                    {new Date(group.created_at).toLocaleString()}
                </span>
            </div>
            <ul className="space-y-1.5">
                {group.events.map((ev) => (
                    <li
                        key={ev.event_id}
                        className="flex items-start justify-between gap-3 border border-slate-100 bg-slate-50 px-2 py-1.5"
                    >
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                {onOpenEvent ? (
                                    <button
                                        type="button"
                                        onClick={() => onOpenEvent(ev.event_id)}
                                        className="font-medium text-blue-600 hover:underline text-left text-xs"
                                    >
                                        {ev.title}
                                    </button>
                                ) : (
                                    <span className="font-medium text-xs">{ev.title}</span>
                                )}
                                {group.kept_event_id === ev.event_id && (
                                    <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-emerald-100 text-emerald-700">
                                        kept
                                    </span>
                                )}
                                {ev.rejected_duplicate_reason && (
                                    <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-slate-200 text-slate-600">
                                        rejected
                                    </span>
                                )}
                            </div>
                            <div className="mt-0.5 text-[10px] text-slate-500">
                                {new Date(ev.start).toLocaleString()} — {ev.event_id}
                            </div>
                            {ev.rejected_duplicate_reason && (
                                <div className="mt-0.5 text-[10px] text-slate-500 italic">
                                    {ev.rejected_duplicate_reason}
                                </div>
                            )}
                        </div>
                        {group.status === 'pending' && (
                            <button
                                disabled={acting}
                                onClick={() => onKeep(ev.event_id)}
                                className="text-[11px] bg-blue-500 text-white px-2 py-1 hover:bg-blue-600 disabled:opacity-50 shrink-0"
                            >
                                Keep
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {group.status === 'pending' && (
                <div className="mt-2">
                    <button
                        disabled={acting}
                        onClick={onDismiss}
                        className="text-[11px] text-slate-500 hover:text-slate-700 px-2 py-1 disabled:opacity-50"
                    >
                        Not duplicates — dismiss group
                    </button>
                </div>
            )}
        </div>
    );
}
