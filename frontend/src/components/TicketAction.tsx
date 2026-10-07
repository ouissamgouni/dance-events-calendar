import { useState } from 'react';
import { Ticket, X } from 'lucide-react';
import { setTicketNotNeeded } from '../api';
import { usePatchEventAssetSummary } from '../context/EventAssetSummaryContext';
import { useTicketAction, type TicketActionState } from '../hooks/useTicketAction';
import type { CalendarEvent, EventAssetSummary } from '../types';
import TicketSheet from './TicketSheet';

interface TicketActionProps {
    event: CalendarEvent;
    variant?: 'full' | 'compact';
    /** Pre-fetched summary (lists that batch their own fetch); skips the shared cache. */
    summary?: EventAssetSummary | null;
    /** Ask "Add ticket?" with a × that hides the inline CTA (marks no ticket needed). */
    dismissible?: boolean;
    /** Only show "My ticket" when one is saved; never prompt to add. */
    existingOnly?: boolean;
}

export function TicketActionButton({ event, state, variant = 'compact', dismissible = false }: {
    event: CalendarEvent;
    state: TicketActionState;
    variant?: 'full' | 'compact';
    dismissible?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const patchSummary = usePatchEventAssetSummary();
    const ask = dismissible && state.label === 'Add ticket';
    const tone = state.eventDay
        ? 'border-action bg-action text-white hover:opacity-90'
        : 'border-line bg-surface text-action hover:bg-canvas';
    const size = variant === 'full'
        ? 'gap-2 px-3 py-2 text-sm'
        : 'pointer-events-auto relative z-[2] gap-1.5 px-2 py-1 text-xs';
    const dismiss = (clickEvent: React.MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        patchSummary(event.event_id, { ticket_not_needed: true });
        setTicketNotNeeded(event.event_id, true).catch(() => patchSummary(event.event_id, { ticket_not_needed: false }));
    };
    return (
        <>
            <span className="relative inline-flex shrink-0">
                <button
                    type="button"
                    onClick={(clickEvent) => {
                        clickEvent.preventDefault();
                        clickEvent.stopPropagation();
                        setOpen(true);
                    }}
                    className={`inline-flex items-center whitespace-nowrap rounded-field border font-semibold ${size} ${tone}`}
                >
                    <Ticket size={variant === 'full' ? 16 : 14} aria-hidden="true" />
                    {ask ? 'Add ticket?' : state.label}
                </button>
                {ask && (
                    <button
                        type="button"
                        onClick={dismiss}
                        aria-label="Dismiss add ticket"
                        className="absolute -top-2 -right-2 z-[3] flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-ink-soft shadow-sm hover:text-ink"
                    >
                        <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                )}
            </span>
            {open && (
                // React events bubble through portals; keep sheet clicks off the host card.
                <span className="contents" onClick={(e) => e.stopPropagation()}>
                    <TicketSheet event={event} onClose={() => setOpen(false)} />
                </span>
            )}
        </>
    );
}

/** Inline ticket CTA; hidden unless the event is ticket-eligible or a ticket exists. */
export default function TicketAction({ event, variant = 'compact', summary, dismissible, existingOnly }: TicketActionProps) {
    const state = useTicketAction(event, summary);
    const show = state?.inline && (!existingOnly || state.label === 'My ticket');
    return state && show ? <TicketActionButton event={event} state={state} variant={variant} dismissible={dismissible} /> : null;
}
