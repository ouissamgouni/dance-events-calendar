import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CalendarEvent } from '../types';
import { fetchEvent } from '../api';
import EventDetailsPanel from './EventDetailsPanel';
import useBackToClose from '../hooks/useBackToClose';

/** EventModal for callers that only know the event id. */
export function EventIdModal({ eventId, onClose, source }: { eventId: string; onClose: () => void; source?: string }) {
    const navigate = useNavigate();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    useEffect(() => {
        let cancelled = false;
        fetchEvent(eventId)
            .then((loaded) => { if (!cancelled) setEvent(loaded); })
            .catch(() => { if (!cancelled) navigate(`/event/${encodeURIComponent(eventId)}${source ? `?src=${source}` : ''}`); });
        return () => { cancelled = true; };
    }, [eventId, navigate, source]);
    return <EventModal event={event} onClose={onClose} source={source} />;
}

interface Props {
    /** null renders a loading state (same history entry as the loaded modal). */
    event: CalendarEvent | null;
    onClose: () => void;
    onEdit?: (event: CalendarEvent) => void;
    source?: string;
}

export default function EventModal({ event, onClose, onEdit, source }: Props) {
    useBackToClose(onClose);
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
            {!event ? (
                <div role="status" className="rounded-card bg-surface px-4 py-3 text-sm text-ink-soft shadow-2xl">Loading event…</div>
            ) : <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg min-w-0">
                <EventDetailsPanel
                    event={event}
                    onClose={onClose}
                    onEdit={onEdit}
                    surface="card"
                    className="w-full max-h-[90vh]"
                    bodyClassName="flex-1 min-h-0"
                    source={source}
                />
            </div>}
        </div>
    );
}
