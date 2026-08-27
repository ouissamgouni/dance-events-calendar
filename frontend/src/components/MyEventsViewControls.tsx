import { CalendarDays, List, Map, Plus } from 'lucide-react';
import type { MyEventsView } from '../utils/myEvents';

interface Props {
    view: MyEventsView;
    searchOpen: boolean;
    onViewChange: (view: MyEventsView) => void;
    onToggleSearch: () => void;
}

const options: Array<{ view: MyEventsView; label: string; icon: typeof List }> = [
    { view: 'list', label: 'List', icon: List },
    { view: 'calendar', label: 'Calendar', icon: CalendarDays },
    { view: 'map', label: 'Map', icon: Map },
];

const orderByView: Record<MyEventsView, MyEventsView[]> = {
    list: ['map', 'calendar'],
    calendar: ['list', 'map'],
    map: ['list', 'calendar'],
};

export default function MyEventsViewControls({ view, searchOpen, onViewChange, onToggleSearch }: Props) {
    const visibleOptions = orderByView[view].map((nextView) => options.find((option) => option.view === nextView)!);
    return (
        <div className="grid grid-cols-3 border-b border-line bg-canvas px-3 py-2 sm:px-4" data-testid="my-events-view-controls">
            {visibleOptions.map((option) => {
                const Icon = option.icon;
                return (
                    <button
                        key={option.view}
                        type="button"
                        onClick={() => onViewChange(option.view)}
                        className="inline-flex h-9 min-w-0 items-center justify-center gap-1.5 border-r border-line px-2 text-xs font-semibold text-ink-soft transition first:border-l hover:bg-surface hover:text-ink"
                        aria-label={`${option.label} view`}
                    >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {option.label}
                    </button>
                );
            })}
            <button
                type="button"
                onClick={onToggleSearch}
                aria-label={searchOpen ? 'Close event search' : 'Add an event'}
                aria-expanded={searchOpen}
                className={`inline-flex h-9 min-w-0 items-center justify-center gap-1.5 border-r border-line px-2 text-xs font-semibold transition ${searchOpen ? 'bg-surface text-action' : 'text-ink-soft hover:bg-surface hover:text-ink'}`}
            >
                <Plus className={`h-4 w-4 transition ${searchOpen ? 'rotate-45' : ''}`} aria-hidden="true" />
                <span>{searchOpen ? 'Close' : 'Add event'}</span>
            </button>
        </div>
    );
}
