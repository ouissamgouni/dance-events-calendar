import { useEffect, useState, type ReactNode } from 'react';
import { fetchAdminEvent } from '../api';
import {
    ADMIN_EVENT_STATUS_CHIP_CLASSES,
    ADMIN_EVENT_STATUS_LABELS,
    getAdminEventStatus,
} from '../utils/adminEventStatus';
import VisibilityChip from './VisibilityChip';
import type { CalendarEvent } from '../types';

const fmtRange = (event: CalendarEvent) => {
    const opts: Intl.DateTimeFormatOptions = event.all_day
        ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
        : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    return `${new Date(event.start).toLocaleString(undefined, opts)} – ${new Date(event.end).toLocaleString(undefined, opts)}`;
};

interface Props {
    eventId: string;
    onClose: () => void;
    /** Footer buttons; a Close button is shown when omitted. */
    actions?: (event: CalendarEvent) => ReactNode;
}

/** Read-only admin summary of an event, shown above the event side panel. */
export default function AdminEventOverviewModal({ eventId, onClose, actions }: Props) {
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setEvent(null);
        setError(false);
        fetchAdminEvent(eventId)
            .then((e) => { if (!cancelled) setEvent(e); })
            .catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [eventId]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopImmediatePropagation();
            onClose();
        };
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [onClose]);

    const status = event ? getAdminEventStatus(event) : null;
    const image = event?.image_thumb_url ?? event?.image_url;

    return (
        <div
            className="fixed inset-0 z-[70] flex items-end justify-center bg-black/30 sm:items-center"
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Event overview"
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-card bg-surface shadow-xl"
            >
                <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-semibold text-ink">{event?.title ?? (error ? 'Event' : 'Loading…')}</h2>
                        {event && (
                            <p className="mt-0.5 truncate font-mono text-[10px] text-muted" title={event.event_id}>ID: {event.event_id}</p>
                        )}
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close" className="px-1 text-sm text-muted hover:text-ink">✕</button>
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs text-ink">
                    {error && <p className="text-danger">Failed to load event.</p>}
                    {event && status && (
                        <>
                            {image && <img src={image} alt="" className="aspect-video w-full object-cover" />}
                            <div className="flex flex-wrap items-center gap-1">
                                <span className={`px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${ADMIN_EVENT_STATUS_CHIP_CLASSES[status]}`}>
                                    {ADMIN_EVENT_STATUS_LABELS[status]}
                                </span>
                                {event.visibility_state && <VisibilityChip state={event.visibility_state} />}
                                {event.is_submission && (
                                    <span className="bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-action">Submitted</span>
                                )}
                            </div>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                                <dt className="text-ink-soft">When</dt>
                                <dd>{fmtRange(event)}</dd>
                                <dt className="text-ink-soft">Where</dt>
                                <dd>{event.location || '—'}</dd>
                                <dt className="text-ink-soft">Calendar</dt>
                                <dd className="truncate">{event.calendar_id}</dd>
                                {event.organizer && (
                                    <>
                                        <dt className="text-ink-soft">Organizer</dt>
                                        <dd>{event.organizer.display_name || `@${event.organizer.handle}`}</dd>
                                    </>
                                )}
                                {event.submitter_name && (
                                    <>
                                        <dt className="text-ink-soft">Submitted by</dt>
                                        <dd>{event.submitter_name}</dd>
                                    </>
                                )}
                            </dl>
                            {event.tags.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {event.tags.map((t) => (
                                        <span key={t.id} className="bg-canvas px-1.5 py-0.5 text-[10px] text-ink-soft">{t.label}</span>
                                    ))}
                                </div>
                            )}
                            {event.description && (
                                <p className="line-clamp-6 whitespace-pre-line text-ink">{event.description}</p>
                            )}
                            {(event.links?.length ?? 0) > 0 && (
                                <ul className="space-y-0.5">
                                    {event.links!.map((l) => (
                                        <li key={l.url} className="truncate">
                                            <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-action hover:underline">{l.label || l.url}</a>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2">
                    {event && actions ? actions(event) : (
                        <button type="button" onClick={onClose} className="px-2.5 py-1 text-xs font-medium text-ink-soft hover:text-ink">
                            Close
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
