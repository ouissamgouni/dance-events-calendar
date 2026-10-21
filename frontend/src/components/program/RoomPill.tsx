import type { ScheduleRoom, ScheduleVenue } from '../../types';
import { scheduleColor } from '../../utils/scheduleColors';

interface Props {
    room?: ScheduleRoom | null;
    /** All rooms of a multi-room session; takes precedence over `room`. */
    rooms?: ScheduleRoom[];
    venue?: ScheduleVenue | null;
    compact?: boolean;
}

export default function RoomPill({ room, rooms, venue, compact = false }: Props) {
    const allRooms = rooms?.length ? rooms : room ? [room] : [];
    const color = scheduleColor(allRooms[0]?.color ?? 'slate');
    return (
        <span className={`inline-flex min-w-0 items-center gap-1 rounded-field font-semibold ${color.pill} ${compact ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-xs'}`}>
            <span className="truncate">{allRooms.length ? allRooms.map((item) => item.name).join(' + ') : venue?.name ?? 'Event-wide'}</span>
            {allRooms.length && venue ? <span className="truncate font-normal opacity-75">· {venue.name}</span> : null}
        </span>
    );
}
