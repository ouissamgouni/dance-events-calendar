import type { EventSchedule, ScheduleSession } from '../../types';
import { formatDayLabel, programDayOf, sessionsForDay, type ScheduleFilters } from '../../utils/schedule';

interface FilterProps {
    schedule: EventSchedule;
    filters: ScheduleFilters;
    onChange: (filters: ScheduleFilters) => void;
}

export function ProgramFilters({ schedule, filters, onChange }: FilterProps) {
    const activeCount = (filters.instructor.trim() ? 1 : 0) + filters.levelIds.length + filters.activityTypeIds.length;
    const toggle = (key: 'levelIds' | 'activityTypeIds', id: number) => {
        const values = filters[key];
        onChange({ ...filters, [key]: values.includes(id) ? values.filter((value) => value !== id) : [...values, id] });
    };
    return <div className="mx-auto w-full max-w-5xl border-t border-line py-3">
        <div className="flex items-center gap-2"><label className="min-w-0 flex-1"><span className="sr-only">Search instructors</span><input type="search" value={filters.instructor} onChange={(event) => onChange({ ...filters, instructor: event.target.value })} placeholder="Search instructors" className="w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink" /></label>{activeCount ? <button type="button" onClick={() => onChange({ instructor: '', levelIds: [], activityTypeIds: [] })} className="shrink-0 text-sm font-semibold text-action">Clear ({activeCount})</button> : null}</div>
        <div className="mt-2 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {schedule.levels.map((level) => <button key={`level-${level.id}`} type="button" aria-pressed={filters.levelIds.includes(level.id)} onClick={() => toggle('levelIds', level.id)} className={`shrink-0 rounded-field border px-2.5 py-1.5 text-xs font-semibold ${filters.levelIds.includes(level.id) ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft'}`}>{level.label}</button>)}
            {schedule.activity_types.map((type) => <button key={`type-${type.id}`} type="button" aria-pressed={filters.activityTypeIds.includes(type.id)} onClick={() => toggle('activityTypeIds', type.id)} className={`shrink-0 rounded-field border px-2.5 py-1.5 text-xs font-semibold ${filters.activityTypeIds.includes(type.id) ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft'}`}>{type.name}</button>)}
        </div>
    </div>;
}

interface DayPickerProps {
    schedule: EventSchedule;
    sessions: ScheduleSession[];
    selectedDay: string;
    filtersActive?: boolean;
    onSelect: (day: string) => void;
    endSlot?: React.ReactNode;
}

export function ProgramDayPicker({ schedule, sessions, selectedDay, filtersActive = false, onSelect, endSlot }: DayPickerProps) {
    const today = programDayOf(new Date(), schedule.timezone, schedule.day_start_hour);
    return <div className="mx-auto flex w-full max-w-5xl gap-2 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {schedule.days.map((day) => {
            const matches = sessionsForDay(sessions, day, schedule.timezone, schedule.day_start_hour).length;
            return <button key={day} type="button" onClick={() => onSelect(day)} aria-current={day === today ? 'date' : undefined} className={`shrink-0 rounded-field border px-3 py-2 text-xs font-semibold ${selectedDay === day ? 'border-action bg-action text-white' : day === today ? 'border-action bg-action/10 text-action' : 'border-line bg-surface text-ink-soft'}`}>
                {formatDayLabel(day)}{filtersActive ? ` · ${matches}` : ''}
            </button>;
        })}
        {endSlot}
    </div>;
}
