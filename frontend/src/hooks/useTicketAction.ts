import { useState } from 'react';
import { useOptionalAuth } from '../context/AuthContext';
import { useOptionalAttendingEvents } from '../context/AttendingEventsContext';
import { useEventAssetSummary } from '../context/EventAssetSummaryContext';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import type { CalendarEvent, EventAssetSummary } from '../types';

export interface TicketActionState {
    label: 'My ticket' | 'Add ticket';
    eventDay: boolean;
    /** Show on cards / modal / page; otherwise only in the overflow menu. */
    inline: boolean;
}

const EVENT_DAY_LEAD_MS = 6 * 60 * 60 * 1000;
const NO_ASSETS: EventAssetSummary = {
    ticket_count: 0,
    memory_count: 0,
    memory_thumbs: [],
    can_add_memory: false,
    memory_window_closes_at: null,
};

/** Ticket CTA state for a Going user of a not-yet-ended event, or null.
 *  ``summary`` comes from lists that batch their own fetch; it skips the shared cache. */
export function useTicketAction(event: CalendarEvent, summary?: EventAssetSummary | null): TicketActionState | null {
    const user = useOptionalAuth()?.user;
    const { eventTicketsEnabled } = useOptionalFeatureFlags();
    const [now] = useState(() => Date.now());
    const active = Boolean(user) && Boolean(eventTicketsEnabled);
    const cached = useEventAssetSummary(active && summary === undefined ? event.event_id : null);
    const attending = useOptionalAttendingEvents();
    // A provided summary row already proves the user is Going.
    const going = summary !== undefined || !attending || attending.isAttending(event.event_id);
    // A fresh RSVP after the summary was fetched: nothing saved yet.
    const entry = summary !== undefined
        ? summary
        : cached === null && going ? NO_ASSETS : cached;
    if (!active || !going || !entry) return null;
    if (now >= new Date(event.end).getTime()) return null;

    const hasTicket = entry.ticket_count > 0;
    const likely = event.ticket_likely ?? entry.ticket_likely ?? false;
    return {
        label: hasTicket ? 'My ticket' : 'Add ticket',
        eventDay: hasTicket && now >= new Date(event.start).getTime() - EVENT_DAY_LEAD_MS,
        inline: hasTicket || (likely && !entry.ticket_not_needed),
    };
}
