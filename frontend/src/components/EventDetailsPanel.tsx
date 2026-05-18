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
        ? 'rounded-2xl bg-white shadow-2xl border border-slate-200'
        : '';

    return (
        <div className={`flex flex-col ${surfaceClassName} ${className}`.trim()}>
            <div className="flex items-start justify-between border-b border-slate-100 px-6 pt-5 pb-4">
                <div className="min-w-0 flex-1 mr-3">
                    <h2 className="text-lg font-bold text-slate-900 leading-snug">
                        {event.title}
                    </h2>
                    <Link
                        to={`/event/${event.event_id}${source ? `?src=${source}` : ''}`}
                        className="text-xs text-rose-500 hover:text-rose-700 hover:underline mt-0.5 inline-block"
                    >
                        See full details →
                    </Link>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <SaveEventButton eventId={event.event_id} appearance="icon" />
                    <GoingButton eventId={event.event_id} appearance="icon" />
                    {onHide && (
                        <button
                            onClick={onHide}
                            className="text-xs px-2 py-1 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                            title="Hide event"
                        >
                            Hide
                        </button>
                    )}
                    {onPermanentlyRemove && (
                        confirmRemove ? (
                            <>
                                <span className="text-xs text-gray-600">Remove?</span>
                                <button
                                    onClick={() => { setConfirmRemove(false); onPermanentlyRemove(); }}
                                    className="text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white"
                                >
                                    Yes
                                </button>
                                <button
                                    onClick={() => setConfirmRemove(false)}
                                    className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600"
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={() => setConfirmRemove(true)}
                                className="text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white"
                            >
                                Remove
                            </button>
                        )
                    )}
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
                <EventDetailContent event={event} onEdit={onEdit} compact={true} />
            </div>
        </div>
    );
}
