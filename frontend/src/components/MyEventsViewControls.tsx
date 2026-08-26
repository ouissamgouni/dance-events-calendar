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

export default function MyEventsViewControls({ view, searchOpen, onViewChange, onToggleSearch }: Props) {
    return (
        <div className="fixed bottom-[calc(76px+env(safe-area-inset-bottom))] left-1/2 z-[7800] flex -translate-x-1/2 items-center gap-2 md:bottom-6" data-testid="my-events-view-controls">
            <div className="flex h-11 items-stretch overflow-hidden rounded-full border border-line bg-surface p-1 shadow-lg">
                {options.filter((option) => option.view !== view).map((option) => {
                    const Icon = option.icon;
                    return (
                        <button
                            key={option.view}
                            type="button"
                            onClick={() => onViewChange(option.view)}
                            className="inline-flex min-w-24 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium text-ink-soft hover:bg-canvas hover:text-action"
                            aria-label={`${option.label} view`}
                        >
                            <Icon className="h-4 w-4" aria-hidden="true" />
                            {option.label}
                        </button>
                    );
                })}
            </div>
            <button
                type="button"
                onClick={onToggleSearch}
                aria-label={searchOpen ? 'Close event search' : 'Add an event'}
                aria-expanded={searchOpen}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-action text-white shadow-lg hover:opacity-90"
            >
                <Plus className={`h-6 w-6 transition ${searchOpen ? 'rotate-45' : ''}`} aria-hidden="true" />
            </button>
        </div>
    );
}
