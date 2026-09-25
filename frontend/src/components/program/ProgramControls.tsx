import { useId, useState } from 'react';
import { ChevronLeft, ChevronRight, ListFilter, Search, X } from 'lucide-react';
import type { EventSchedule, ScheduleSession } from '../../types';
import { filterScheduleSessions, formatDayLabel, programDayOf, scheduleInstructors, sessionsForDay, type ScheduleFilters } from '../../utils/schedule';
import BottomSheet from '../BottomSheet';

const EMPTY_FILTERS: ScheduleFilters = { instructor: '', levelIds: [], activityTypeIds: [] };
const ATTENDEE_LEVELS = new Set(['open level', 'intermediate', 'advanced']);
const ATTENDEE_ACTIVITY_TYPES = new Set(['workshop', 'social', 'show', 'party', 'rehearsal', 'other']);

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

export function AttendeeProgramFilters({ schedule, filters, onChange }: FilterProps) {
    const instructorSearchId = useId();
    const [sheetOpen, setSheetOpen] = useState(false);
    const [sheetView, setSheetView] = useState<'filters' | 'instructor'>('filters');
    const [draftFilters, setDraftFilters] = useState<ScheduleFilters>(filters);
    const [instructorQuery, setInstructorQuery] = useState('');
    const levels = schedule.levels.filter((level) => ATTENDEE_LEVELS.has(level.label.trim().toLocaleLowerCase()));
    const activityTypes = schedule.activity_types.filter((type) => ATTENDEE_ACTIVITY_TYPES.has(type.name.trim().toLocaleLowerCase()));
    const instructors = scheduleInstructors(schedule.sessions);
    const matchingInstructors = instructors.filter((instructor) => instructor.toLocaleLowerCase().includes(instructorQuery.trim().toLocaleLowerCase()));
    const activeCount = (filters.instructor.trim() ? 1 : 0) + filters.levelIds.length + filters.activityTypeIds.length;
    const draftActiveCount = (draftFilters.instructor.trim() ? 1 : 0) + draftFilters.levelIds.length + draftFilters.activityTypeIds.length;
    const matchingSessionCount = filterScheduleSessions(schedule.sessions, draftFilters).length;
    const levelLabels = levels.filter((level) => filters.levelIds.includes(level.id)).map((level) => level.label);
    const activityLabels = activityTypes.filter((type) => filters.activityTypeIds.includes(type.id)).map((type) => type.name);
    const summaryParts = [levelLabels[0], activityLabels[0], filters.instructor.trim() || undefined, ...levelLabels.slice(1), ...activityLabels.slice(1)]
        .filter((value): value is string => Boolean(value));
    const visibleSummary = summaryParts.slice(0, 2);
    const hiddenCount = Math.max(0, activeCount - visibleSummary.length);
    const summary = `${visibleSummary.join(' · ')}${hiddenCount ? `${visibleSummary.length ? ' · ' : ''}+${hiddenCount}` : ''}`;
    const openSheet = () => {
        setSheetView('filters');
        setInstructorQuery('');
        setSheetOpen(true);
    };
    const closeSheet = () => {
        setSheetOpen(false);
        setSheetView('filters');
        setInstructorQuery('');
    };
    const clearFilters = () => {
        setDraftFilters(EMPTY_FILTERS);
        onChange(EMPTY_FILTERS);
    };
    const selectInstructor = (instructor: string) => {
        setDraftFilters((current) => ({ ...current, instructor }));
        setSheetView('filters');
        setInstructorQuery('');
    };
    const toggleDraft = (key: 'levelIds' | 'activityTypeIds', id: number) => {
        setDraftFilters((current) => {
            const values = current[key];
            return { ...current, [key]: values.includes(id) ? values.filter((value) => value !== id) : [...values, id] };
        });
    };

    return (
        <div className="mx-auto w-full max-w-5xl py-2">
            <div className="flex min-h-11 items-stretch rounded-field border border-line bg-surface">
                <button type="button" onClick={openSheet} className="flex min-w-0 flex-1 items-center gap-3 px-3 text-left text-sm text-ink-soft">
                    <ListFilter size={17} aria-hidden="true" className="shrink-0 text-muted" />
                    <span className={`min-w-0 flex-1 truncate ${activeCount ? 'font-medium text-ink' : ''}`}>{activeCount ? summary : 'Filter schedule'}</span>
                    {!activeCount ? <ChevronRight size={17} aria-hidden="true" className="shrink-0 text-muted" /> : null}
                </button>
                {activeCount ? (
                    <button type="button" onClick={clearFilters} aria-label="Clear schedule filters" className="flex w-11 shrink-0 items-center justify-center border-l border-line text-muted hover:text-ink">
                        <X size={17} aria-hidden="true" />
                    </button>
                ) : null}
            </div>

            {sheetOpen ? (
                <BottomSheet
                    title={sheetView === 'filters' ? 'Filter schedule' : 'Select instructor'}
                    onClose={closeSheet}
                    headerLeading={sheetView === 'instructor' ? (
                        <button type="button" onClick={() => { setSheetView('filters'); setInstructorQuery(''); }} aria-label="Back to filters" className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft hover:bg-canvas">
                            <ChevronLeft size={20} aria-hidden="true" />
                        </button>
                    ) : undefined}
                    headerAction={sheetView === 'filters' ? <button type="button" disabled={!draftActiveCount} onClick={() => setDraftFilters(EMPTY_FILTERS)} className="px-2 py-2 text-sm font-semibold text-action disabled:text-muted">Reset</button> : undefined}
                    showClose={sheetView === 'filters'}
                    footer={sheetView === 'filters' ? (
                        <button
                            type="button"
                            disabled={!matchingSessionCount}
                            onClick={() => { onChange(draftFilters); closeSheet(); }}
                            className="min-h-11 w-full rounded-field bg-action px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:bg-canvas disabled:text-ink-soft"
                        >
                            {matchingSessionCount ? `Show ${matchingSessionCount} ${matchingSessionCount === 1 ? 'session' : 'sessions'}` : 'No sessions match'}
                        </button>
                    ) : undefined}
                >
                    {sheetView === 'filters' ? <div className="space-y-5">
                        {levels.length ? (
                            <fieldset>
                                <legend className="mb-2 text-sm font-semibold text-ink">Level</legend>
                                <div className="grid grid-cols-3 gap-2">
                                    {levels.map((level) => (
                                        <button key={level.id} type="button" aria-pressed={draftFilters.levelIds.includes(level.id)} onClick={() => toggleDraft('levelIds', level.id)} className={`min-h-11 rounded-field border px-2 py-2 text-sm font-medium ${draftFilters.levelIds.includes(level.id) ? 'border-action bg-action/10 text-action' : 'border-line bg-surface text-ink-soft'}`}>
                                            {level.label}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>
                        ) : null}
                        {activityTypes.length ? (
                            <fieldset>
                                <legend className="mb-2 text-sm font-semibold text-ink">Activity type</legend>
                                <div className="flex flex-wrap gap-2">
                                    {activityTypes.map((type) => (
                                        <button key={type.id} type="button" aria-pressed={draftFilters.activityTypeIds.includes(type.id)} onClick={() => toggleDraft('activityTypeIds', type.id)} className={`min-h-11 rounded-field border px-3 py-2 text-sm font-medium ${draftFilters.activityTypeIds.includes(type.id) ? 'border-action bg-action/10 text-action' : 'border-line bg-surface text-ink-soft'}`}>
                                            {type.name}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>
                        ) : null}
                        <div>
                            <p className="mb-2 text-sm font-semibold text-ink">Instructor</p>
                            <button type="button" onClick={() => { setInstructorQuery(''); setSheetView('instructor'); }} className="flex min-h-11 w-full items-center justify-between rounded-field border border-line bg-surface px-3 text-left text-sm text-ink">
                                <span className="truncate">{draftFilters.instructor || 'All instructors'}</span>
                                <ChevronRight size={17} aria-hidden="true" className="shrink-0 text-muted" />
                            </button>
                        </div>
                    </div> : (
                        <div>
                            <label htmlFor={instructorSearchId} className="sr-only">Search instructors</label>
                            <div className="relative">
                                <Search size={17} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                                <input id={instructorSearchId} type="search" autoFocus value={instructorQuery} onChange={(event) => setInstructorQuery(event.target.value)} placeholder="Search instructors…" className="min-h-11 w-full rounded-field border border-line bg-surface py-2 pl-10 pr-3 text-base text-ink outline-none focus:border-action sm:text-sm" />
                            </div>
                            <fieldset className="mt-3 divide-y divide-line">
                                <legend className="sr-only">Instructor</legend>
                                <InstructorOption instructor="" selected={!draftFilters.instructor} onSelect={selectInstructor} />
                                {matchingInstructors.map((instructor) => <InstructorOption key={instructor} instructor={instructor} selected={draftFilters.instructor === instructor} onSelect={selectInstructor} />)}
                            </fieldset>
                            {instructorQuery.trim() && !matchingInstructors.length ? <p className="py-8 text-center text-sm text-ink-soft">No instructors found</p> : null}
                        </div>
                    )}
                </BottomSheet>
            ) : null}
        </div>
    );
}

function InstructorOption({ instructor, selected, onSelect }: { instructor: string; selected: boolean; onSelect: (instructor: string) => void }) {
    const label = instructor || 'All instructors';
    return (
        <label className="flex min-h-11 cursor-pointer items-center gap-3 py-2 text-sm text-ink">
            <input type="radio" name="schedule-instructor" value={instructor} checked={selected} onChange={() => onSelect(instructor)} className="h-5 w-5 shrink-0 accent-action" />
            <span>{label}</span>
        </label>
    );
}

interface DayPickerProps {
    schedule: EventSchedule;
    sessions: ScheduleSession[];
    selectedDay: string;
    includeAll?: boolean;
    filtersActive?: boolean;
    softSelection?: boolean;
    onSelect: (day: string) => void;
    endSlot?: React.ReactNode;
}

export function ProgramDayPicker({ schedule, sessions, selectedDay, includeAll = false, filtersActive = false, softSelection = false, onSelect, endSlot }: DayPickerProps) {
    const today = programDayOf(new Date(), schedule.timezone, schedule.day_start_hour);
    return <div className="mx-auto flex w-full max-w-5xl gap-2 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {includeAll ? <button type="button" onClick={() => onSelect('')} aria-pressed={selectedDay === ''} className={`shrink-0 rounded-field border px-3 py-2 text-xs font-semibold ${selectedDay === '' ? (softSelection ? 'border-action/30 bg-action/10 text-action' : 'border-action bg-action text-white') : 'border-line bg-surface text-ink-soft'}`}>All</button> : null}
        {schedule.days.map((day) => {
            const matches = sessionsForDay(sessions, day, schedule.timezone, schedule.day_start_hour).length;
            return <button key={day} type="button" onClick={() => onSelect(day)} aria-current={day === today ? 'date' : undefined} className={`shrink-0 rounded-field border px-3 py-2 text-xs font-semibold ${selectedDay === day ? (softSelection ? 'border-action/30 bg-action/10 text-action' : 'border-action bg-action text-white') : day === today ? 'border-action bg-action/10 text-action' : 'border-line bg-surface text-ink-soft'}`}>
                {formatDayLabel(day)}{filtersActive ? ` · ${matches}` : ''}
            </button>;
        })}
        {endSlot}
    </div>;
}
