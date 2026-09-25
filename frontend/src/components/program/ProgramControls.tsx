import { useId, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { EventSchedule, ScheduleSession } from '../../types';
import { formatDayLabel, programDayOf, scheduleInstructors, sessionsForDay, type ScheduleFilters } from '../../utils/schedule';

interface FilterProps {
    schedule: EventSchedule;
    filters: ScheduleFilters;
    onChange: (filters: ScheduleFilters) => void;
}

export function ProgramFilters({ schedule, filters, onChange }: FilterProps) {
    const instructorInputId = useId();
    const instructorListId = useId();
    const [suggestionsOpen, setSuggestionsOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const instructors = scheduleInstructors(schedule.sessions);
    const instructorQuery = filters.instructor.trim().toLocaleLowerCase();
    const matchingInstructors = instructors
        .filter((instructor) => !instructorQuery || instructor.toLocaleLowerCase().includes(instructorQuery));
    const activeCount = (filters.instructor.trim() ? 1 : 0) + filters.levelIds.length + filters.activityTypeIds.length;
    const toggle = (key: 'levelIds' | 'activityTypeIds', id: number) => {
        const values = filters[key];
        onChange({ ...filters, [key]: values.includes(id) ? values.filter((value) => value !== id) : [...values, id] });
    };
    const selectInstructor = (instructor: string) => {
        onChange({ ...filters, instructor });
        setSuggestionsOpen(false);
    };
    return <div className="mx-auto w-full max-w-5xl border-t border-line py-3">
        <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSuggestionsOpen(false); }}>
                <label htmlFor={instructorInputId} className="sr-only">Search instructors</label>
                <Search size={17} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                    id={instructorInputId}
                    type="text"
                    inputMode="search"
                    role="combobox"
                    autoComplete="off"
                    aria-autocomplete="list"
                    aria-expanded={suggestionsOpen && matchingInstructors.length > 0}
                    aria-controls={instructorListId}
                    aria-activedescendant={suggestionsOpen && matchingInstructors[activeIndex] ? `${instructorListId}-${activeIndex}` : undefined}
                    value={filters.instructor}
                    onFocus={() => setSuggestionsOpen(true)}
                    onChange={(event) => { onChange({ ...filters, instructor: event.target.value }); setActiveIndex(0); setSuggestionsOpen(true); }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') { setSuggestionsOpen(false); return; }
                        if (event.key === 'ArrowDown') { event.preventDefault(); setSuggestionsOpen(true); setActiveIndex((value) => Math.min(value + 1, matchingInstructors.length - 1)); }
                        if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((value) => Math.max(value - 1, 0)); }
                        if (event.key === 'Enter' && suggestionsOpen && matchingInstructors[activeIndex]) { event.preventDefault(); selectInstructor(matchingInstructors[activeIndex]); }
                    }}
                    placeholder="Search instructors"
                    className="min-h-11 w-full rounded-field border border-line bg-surface py-2 pl-10 pr-10 text-base text-ink outline-none focus:border-action sm:text-sm"
                />
                {filters.instructor ? <button type="button" onClick={() => { onChange({ ...filters, instructor: '' }); setActiveIndex(0); setSuggestionsOpen(true); }} aria-label="Clear instructor filter" className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-muted hover:text-ink"><X size={17} /></button> : null}
                {suggestionsOpen && matchingInstructors.length ? <div id={instructorListId} role="listbox" aria-label="Instructor suggestions" className="absolute inset-x-0 top-[calc(100%+0.375rem)] z-[12000] max-h-64 overflow-y-auto rounded-card border border-card-line bg-surface p-1.5 shadow-xl">
                    {matchingInstructors.map((instructor, index) => <button key={instructor} id={`${instructorListId}-${index}`} type="button" role="option" aria-selected={index === activeIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => selectInstructor(instructor)} className={`flex min-h-11 w-full items-center px-3 text-left text-sm font-medium ${index === activeIndex ? 'bg-action/10 text-action' : 'text-ink hover:bg-canvas'}`}>{instructor}</button>)}
                </div> : null}
            </div>
            {activeCount ? <button type="button" onClick={() => onChange({ instructor: '', levelIds: [], activityTypeIds: [] })} className="shrink-0 text-sm font-semibold text-action">Clear ({activeCount})</button> : null}
        </div>
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
    includeAll?: boolean;
    filtersActive?: boolean;
    onSelect: (day: string) => void;
    endSlot?: React.ReactNode;
}

export function ProgramDayPicker({ schedule, sessions, selectedDay, includeAll = false, filtersActive = false, onSelect, endSlot }: DayPickerProps) {
    const today = programDayOf(new Date(), schedule.timezone, schedule.day_start_hour);
    return <div className="mx-auto flex w-full max-w-5xl gap-2 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {includeAll ? <button type="button" onClick={() => onSelect('')} aria-pressed={selectedDay === ''} className={`shrink-0 rounded-field border px-3 py-2 text-xs font-semibold ${selectedDay === '' ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft'}`}>All</button> : null}
        {schedule.days.map((day) => {
            const matches = sessionsForDay(sessions, day, schedule.timezone, schedule.day_start_hour).length;
            return <button key={day} type="button" onClick={() => onSelect(day)} aria-current={day === today ? 'date' : undefined} className={`shrink-0 rounded-field border px-3 py-2 text-xs font-semibold ${selectedDay === day ? 'border-action bg-action text-white' : day === today ? 'border-action bg-action/10 text-action' : 'border-line bg-surface text-ink-soft'}`}>
                {formatDayLabel(day)}{filtersActive ? ` · ${matches}` : ''}
            </button>;
        })}
        {endSlot}
    </div>;
}
