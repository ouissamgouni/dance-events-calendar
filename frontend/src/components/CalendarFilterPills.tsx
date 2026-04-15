import type { CalendarSetting } from '../types';

interface Props {
    calendars: CalendarSetting[];
    activeIds: Set<string>;
    onToggle: (calendarId: string) => void;
}

export default function CalendarFilterPills({ calendars, activeIds, onToggle }: Props) {
    if (calendars.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-1.5 items-end">
            {calendars.map((cal) => {
                const active = activeIds.has(cal.calendar_id);
                const color = cal.color || '#3b82f6';
                return (
                    <button
                        key={cal.calendar_id}
                        onClick={() => onToggle(cal.calendar_id)}
                        className="px-2 py-1 text-[11px] font-semibold transition-all duration-150 border"
                        style={
                            active
                                ? { backgroundColor: color, borderColor: color, color: '#fff' }
                                : { backgroundColor: '#fff', borderColor: color, color }
                        }
                    >
                        {cal.name}
                    </button>
                );
            })}
        </div>
    );
}
