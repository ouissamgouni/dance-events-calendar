import type { ScheduleRoom, ScheduleVenue } from '../../types';

export const ROOM_COLORS: Record<string, { pill: string; cell: string; header: string }> = {
    blue: { pill: 'bg-blue-100 text-blue-800', cell: 'border-blue-200 bg-blue-50', header: 'bg-blue-100 text-blue-900' },
    amber: { pill: 'bg-amber-100 text-amber-900', cell: 'border-amber-200 bg-amber-50', header: 'bg-amber-100 text-amber-950' },
    pink: { pill: 'bg-pink-100 text-pink-900', cell: 'border-pink-200 bg-pink-50', header: 'bg-pink-100 text-pink-950' },
    brown: { pill: 'bg-orange-100 text-orange-950', cell: 'border-orange-200 bg-orange-50', header: 'bg-orange-100 text-orange-950' },
    violet: { pill: 'bg-violet-100 text-violet-900', cell: 'border-violet-200 bg-violet-50', header: 'bg-violet-100 text-violet-950' },
    emerald: { pill: 'bg-emerald-100 text-emerald-900', cell: 'border-emerald-200 bg-emerald-50', header: 'bg-emerald-100 text-emerald-950' },
    indigo: { pill: 'bg-indigo-100 text-indigo-900', cell: 'border-indigo-200 bg-indigo-50', header: 'bg-indigo-100 text-indigo-950' },
    orange: { pill: 'bg-orange-100 text-orange-900', cell: 'border-orange-200 bg-orange-50', header: 'bg-orange-100 text-orange-950' },
    slate: { pill: 'bg-slate-100 text-slate-800', cell: 'border-slate-200 bg-slate-50', header: 'bg-slate-100 text-slate-900' },
};

export function roomColor(color: string) {
    return ROOM_COLORS[color] ?? ROOM_COLORS.blue;
}

interface Props {
    room?: ScheduleRoom | null;
    venue?: ScheduleVenue | null;
    compact?: boolean;
}

export default function RoomPill({ room, venue, compact = false }: Props) {
    const color = roomColor(room?.color ?? 'slate');
    return (
        <span className={`inline-flex min-w-0 items-center gap-1 rounded-field font-semibold ${color.pill} ${compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'}`}>
            <span className="truncate">{room?.name ?? venue?.name ?? 'Event-wide'}</span>
            {room && venue ? <span className="truncate font-normal opacity-75">· {venue.name}</span> : null}
        </span>
    );
}
