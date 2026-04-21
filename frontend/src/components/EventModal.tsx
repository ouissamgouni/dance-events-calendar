import { useEffect } from 'react';
import type { CalendarEvent } from '../types';
import EventDetailsPanel from './EventDetailsPanel';

interface Props {
    event: CalendarEvent;
    onClose: () => void;
    onEdit?: (event: CalendarEvent) => void;
}

export default function EventModal({ event, onClose, onEdit }: Props) {
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
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <div onClick={(e) => e.stopPropagation()}>
                <EventDetailsPanel
                    event={event}
                    onClose={onClose}
                    onEdit={onEdit}
                    surface="card"
                    className="w-full max-w-lg max-h-[85vh]"
                    bodyClassName="max-h-[calc(85vh-80px)]"
                />
            </div>
        </div>
    );
}
