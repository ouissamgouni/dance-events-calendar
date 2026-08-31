import type { CalendarEvent } from '../../types';
import EventMap from '../EventMap';

interface Props {
    event: CalendarEvent;
    /** Open the Location detail tab (full page) or navigate there (modal). */
    onOpen: () => void;
}

/**
 * Short, non-interactive map giving geographical context inside EventSummary.
 * A transparent overlay captures the tap and opens the Location tab rather than
 * letting the user pan — this is context, not directions. Renders nothing when
 * the event has no coordinates.
 */
export default function SummaryMiniMap({ event, onOpen }: Props) {
    if (event.latitude == null || event.longitude == null) return null;

    return (
        <div className="relative h-[100px] w-full overflow-hidden rounded-lg">
            <div className="pointer-events-none absolute inset-0">
                <EventMap events={[event]} recenterTo={[event.latitude, event.longitude]} compact disablePopups />
            </div>
            <button
                type="button"
                onClick={onOpen}
                aria-label="Open location"
                className="absolute inset-0 z-[1] cursor-pointer bg-transparent"
            />
        </div>
    );
}
