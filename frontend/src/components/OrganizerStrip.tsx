import { CalendarDays, PencilLine } from 'lucide-react';
import { Link, useLocation, type Location } from 'react-router-dom';
import { useProgramEditorAccess } from '../hooks/useProgramEditorAccess';
import type { CalendarEvent } from '../types';

interface OrganizerStripProps {
    event: CalendarEvent;
    onNavigate?: () => void;
    className?: string;
}

/** Owner actions on the event page and modal: Edit event for the organizer, Edit program for editors. */
export default function OrganizerStrip({ event, onNavigate, className = '' }: OrganizerStripProps) {
    const location = useLocation();
    const { isOrganizer, canEditProgram } = useProgramEditorAccess(event);
    if (!isOrganizer && !canEditProgram) return null;
    const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation ?? location;
    const action = 'inline-flex items-center gap-2 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas';
    return (
        <div data-testid="organizer-strip" className={`flex flex-wrap items-center gap-2 rounded-card border border-blue-100 bg-blue-50 px-3 py-2 ${className}`.trim()}>
            <span className="mr-auto text-sm font-semibold text-ink">{isOrganizer ? 'You organize this event' : 'Program editor'}</span>
            {isOrganizer ? (
                <Link to={`/event/${event.event_id}/suggest-change`} state={{ backgroundLocation }} onClick={onNavigate} className={action}>
                    <PencilLine size={16} aria-hidden="true" />
                    Edit event
                </Link>
            ) : null}
            {canEditProgram ? (
                <Link to={`/event/${event.event_id}/program/edit`} onClick={onNavigate} className={action}>
                    <CalendarDays size={16} aria-hidden="true" />
                    Edit program
                </Link>
            ) : null}
        </div>
    );
}
