import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../types';
import EventDetailContent from './EventDetailContent';
import GoingButton from './GoingButton';
import SaveEventButton from './SaveEventButton';

interface Props {
    event: CalendarEvent;
    onClose?: () => void;
    onEdit?: (event: CalendarEvent) => void;
    surface?: 'plain' | 'card';
    className?: string;
    bodyClassName?: string;
    /** Source passed as ?src= on the "See full details" link for tracking attribution */
    source?: string;
    /** Admin-only: hide this event (reversible) */
    onHide?: () => void;
    /** Admin-only: permanently remove this event (irreversible) */
    onPermanentlyRemove?: () => void;
}

export default function EventDetailsPanel({
    event,
    onClose,
    onEdit,
    surface = 'card',
    className = '',
    bodyClassName = '',
    source,
    onHide,
    onPermanentlyRemove,
}: Props) {
    const [confirmRemove, setConfirmRemove] = useState(false);
    const surfaceClassName = surface === 'card'
        ? 'rounded-card bg-surface shadow-2xl border border-line'
        : '';

    return (
        <div className={`flex flex-col ${surfaceClassName} ${className}`.trim()}>
            <div className="flex items-start justify-between border-b border-card-line px-6 pt-5 pb-4">
                <div className="min-w-0 flex-1 mr-3">
                    <h2 className="text-lg font-bold text-ink leading-snug">
                        {event.title}
                    </h2>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <SaveEventButton eventId={event.event_id} appearance="icon" />
                    <GoingButton eventId={event.event_id} appearance="icon" isPast={new Date(event.end).getTime() < Date.now()} />
                    {onHide && (
                        <button
                            onClick={onHide}
                            className="text-xs px-2 py-1 border border-line bg-surface text-ink hover:bg-canvas"
                            title="Hide event"
                        >
                            Hide
                        </button>
                    )}
                    {onPermanentlyRemove && (
                        confirmRemove ? (
                            <>
                                <span className="text-xs text-ink-soft">Remove?</span>
                                <button
                                    onClick={() => { setConfirmRemove(false); onPermanentlyRemove(); }}
                                    className="text-xs px-2 py-1 bg-danger hover:bg-danger/90 text-white"
                                >
                                    Yes
                                </button>
                                <button
                                    onClick={() => setConfirmRemove(false)}
                                    className="text-xs px-2 py-1 text-muted hover:text-ink-soft"
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={() => setConfirmRemove(true)}
                                className="text-xs px-2 py-1 bg-danger hover:bg-danger/90 text-white"
                            >
                                Remove
                            </button>
                        )
                    )}
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="rounded-full p-1 text-muted hover:bg-canvas hover:text-ink-soft transition"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    )}
                </div>
            </div>
            <div className={`modal-scroll overflow-y-auto overscroll-contain px-6 py-4 ${bodyClassName}`.trim()}>
                <EventDetailContent event={event} onEdit={onEdit} compact={true} />
            </div>
            <div className="border-t border-card-line px-6 py-3 flex justify-end">
                <Link
                    to={`/event/${event.event_id}${source ? `?src=${source}` : ''}`}
                    className="text-xs text-action hover:text-action hover:underline"
                >
                    See full details →
                </Link>
            </div>
        </div>
    );
}
