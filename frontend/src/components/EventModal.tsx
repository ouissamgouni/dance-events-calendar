import { useEffect } from 'react';
import type { CalendarEvent } from '../types';
import EventDetailsPanel from './EventDetailsPanel';

interface Props {
    event: CalendarEvent;
    onClose: () => void;
    onEdit?: (event: CalendarEvent) => void;
    source?: string;
}

export default function EventModal({ event, onClose, onEdit, source }: Props) {
    // Close on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-3 py-4"
            onClick={onClose}
        >
            <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg min-w-0">
                <EventDetailsPanel
                    event={event}
                    onClose={onClose}
                    onEdit={onEdit}
                    surface="card"
                    className="w-full max-h-[90vh]"
                    bodyClassName="max-h-[calc(90vh-92px)]"
                    source={source}
                />
            </div>
        </div>
    );
}
