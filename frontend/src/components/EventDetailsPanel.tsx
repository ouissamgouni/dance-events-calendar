import type { CalendarEvent } from '../types';
import EventDetailContent from './EventDetailContent';
import SaveEventButton from './SaveEventButton';

interface Props {
    event: CalendarEvent;
    onClose?: () => void;
    onEdit?: (event: CalendarEvent) => void;
    compact?: boolean;
    surface?: 'plain' | 'card';
    className?: string;
    bodyClassName?: string;
}

export default function EventDetailsPanel({
    event,
    onClose,
    onEdit,
    compact = false,
    surface = 'card',
    className = '',
    bodyClassName = '',
}: Props) {
    const surfaceClassName = surface === 'card'
        ? 'rounded-2xl bg-white shadow-2xl border border-slate-200'
        : '';

    return (
        <div className={`flex flex-col ${surfaceClassName} ${className}`.trim()}>
            <div className="flex items-start justify-between border-b border-slate-100 px-6 pt-5 pb-4">
                <h2 className="text-lg font-bold text-slate-900 leading-snug">
                    {event.title}
                </h2>
                <div className="ml-4 flex items-center gap-1 shrink-0">
                    <SaveEventButton eventId={event.event_id} appearance="icon" />
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    )}
                </div>
            </div>
            <div className={`modal-scroll overflow-y-auto overscroll-contain px-6 py-4 ${bodyClassName}`.trim()}>
                <EventDetailContent event={event} onEdit={onEdit} compact={compact} />
            </div>
        </div>
    );
}
