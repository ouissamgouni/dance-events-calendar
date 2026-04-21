import { useSavedEvents } from '../context/SavedEventsContext';

interface Props {
    eventId: string;
    appearance?: 'icon' | 'pill';
    size?: 'sm' | 'md';
    stopPropagation?: boolean;
    className?: string;
}

export default function SaveEventButton({
    eventId,
    appearance = 'icon',
    size = 'md',
    stopPropagation = false,
    className = '',
}: Props) {
    const { isSaved, toggleSave } = useSavedEvents();
    const saved = isSaved(eventId);
    const iconSizeClass = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (stopPropagation) event.stopPropagation();
        toggleSave(eventId);
    };

    if (appearance === 'pill') {
        return (
            <button
                onClick={handleClick}
                className={`text-xs rounded-full px-3 py-1 transition flex items-center gap-1 ${saved ? 'text-slate-800 bg-slate-200 hover:bg-slate-300' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} ${className}`.trim()}
                aria-label={saved ? 'Unsave event' : 'Save event'}
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                </svg>
                {saved ? 'Saved' : 'Save'}
            </button>
        );
    }

    return (
        <button
            onClick={handleClick}
            className={`rounded-full transition ${size === 'sm' ? 'p-0.5' : 'p-1.5'} ${saved ? 'text-slate-700 hover:text-slate-900' : 'text-slate-300 hover:text-slate-500'} ${className}`.trim()}
            aria-label={saved ? 'Unsave event' : 'Save event'}
        >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={iconSizeClass}>
                <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
            </svg>
        </button>
    );
}
