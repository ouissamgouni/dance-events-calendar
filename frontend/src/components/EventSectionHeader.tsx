import { ArrowLeft } from 'lucide-react';
import type { CalendarEvent } from '../types';
import SaveEventButton from './SaveEventButton';
import ShareButton from './ShareButton';

interface Props {
    event: CalendarEvent;
    shareUrl: string;
    /** Return to the overview (exits section mode). */
    onBack: () => void;
}

/** Compact meta line: "Fri, Sep 4 · 9:00 PM · Prague". */
function metaLine(event: CalendarEvent): string {
    const start = new Date(event.start);
    const day = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = event.all_day ? null : start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const place = event.city || event.location || null;
    return [day, time, place].filter(Boolean).join(' · ');
}

/**
 * Sticky, compact header that replaces the overview while a section is open:
 * a back arrow to the overview, the event title, a meta line, and quick
 * bookmark/share actions.
 */
export default function EventSectionHeader({ event, shareUrl, onBack }: Props) {
    return (
        <div className="border-b border-line bg-surface/95 backdrop-blur">
            <div className="flex items-center gap-2 px-2 py-2">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back to overview"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-canvas"
                >
                    <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                </button>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{event.title}</p>
                    <p className="truncate text-xs text-ink-soft">{metaLine(event)}</p>
                </div>
                <SaveEventButton eventId={event.event_id} appearance="icon" />
                <ShareButton eventId={event.event_id} title={event.title} url={shareUrl} />
            </div>
        </div>
    );
}
