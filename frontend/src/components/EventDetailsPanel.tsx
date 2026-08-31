import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CalendarEvent } from '../types';
import EventSummary, { type EventDetailTab } from './EventSummary';

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

/**
 * Event modal body. Renders the shared EventSummary (identical to the full
 * page) and ends with a sticky "See full details →" footer. Any in-summary
 * affordance that would open a detail tab (Posts, review card, mini-map,
 * "Post a message") navigates to the full page instead, since the modal has no
 * tabs of its own.
 */
export default function EventDetailsPanel({
    event,
    onClose,
    surface = 'card',
    className = '',
    bodyClassName = '',
    source,
    onHide,
    onPermanentlyRemove,
}: Props) {
    const navigate = useNavigate();
    const [confirmRemove, setConfirmRemove] = useState(false);
    const surfaceClassName = surface === 'card'
        ? 'rounded-card bg-surface shadow-2xl border border-line'
        : '';

    const detailPath = `/event/${event.event_id}${source ? `?src=${source}` : ''}`;
    const shareUrl = `${window.location.origin}/event/${event.event_id}`;

    const goToTab = (tab: EventDetailTab, opts?: { anchor?: string }) => {
        const params = new URLSearchParams();
        if (source) params.set('src', source);
        params.set('tab', tab);
        navigate({
            pathname: `/event/${event.event_id}`,
            search: `?${params.toString()}`,
            hash: opts?.anchor ? `#${opts.anchor}` : '',
        });
        onClose?.();
    };

    return (
        <div className={`flex flex-col ${surfaceClassName} ${className}`.trim()}>
            <div className="flex items-center justify-end gap-1 border-b border-card-line px-3 py-2">
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
            <div className={`modal-scroll overflow-y-auto overscroll-contain px-4 py-4 ${bodyClassName}`.trim()}>
                <EventSummary
                    event={event}
                    variant="modal"
                    shareUrl={shareUrl}
                    onOpenTab={goToTab}
                    onPostMessage={() => goToTab('discussion')}
                />
            </div>
            <div className="border-t border-card-line px-4 py-3">
                <Link
                    to={detailPath}
                    onClick={() => onClose?.()}
                    className="text-xs font-medium text-action hover:underline"
                >
                    See full details →
                </Link>
            </div>
        </div>
    );
}
