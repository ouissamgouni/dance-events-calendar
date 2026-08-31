import type { CalendarEvent } from '../../types';
import EventMap from '../EventMap';
import { useToast } from '../Toast';

interface Props {
    event: CalendarEvent;
}

/** Location detail tab: an interactive map, the address, and quick actions. */
export default function LocationTab({ event }: Props) {
    const toast = useToast();
    const hasCoords = event.latitude != null && event.longitude != null;
    const address = event.location
        || [event.city, event.country].filter(Boolean).join(', ')
        || null;

    const mapsQuery = encodeURIComponent(address ?? event.title);
    const directionsUrl = hasCoords
        ? `https://www.google.com/maps/dir/?api=1&destination=${event.latitude},${event.longitude}`
        : `https://www.google.com/maps/dir/?api=1&destination=${mapsQuery}`;
    const openMapsUrl = hasCoords
        ? `https://www.google.com/maps/search/?api=1&query=${event.latitude},${event.longitude}`
        : `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;

    const copyAddress = async () => {
        if (!address) return;
        try {
            await navigator.clipboard.writeText(address);
            toast.push({ title: 'Address copied', variant: 'success' });
        } catch {
            toast.push({ title: 'Could not copy address', variant: 'error' });
        }
    };

    return (
        <div className="space-y-4">
            {hasCoords && (
                <div className="h-[200px] w-full overflow-hidden">
                    <EventMap events={[event]} recenterTo={[event.latitude!, event.longitude!]} />
                </div>
            )}

            {address && (
                <div className="space-y-0.5">
                    {event.location && <p className="text-base font-bold text-ink">{event.location}</p>}
                    {(event.city || event.country) && (
                        <p className="text-sm text-ink-soft">{[event.city, event.country].filter(Boolean).join(', ')}</p>
                    )}
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <a
                    href={openMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md bg-action px-3 py-1.5 text-xs font-medium text-white transition hover:bg-action/90"
                >
                    Open in Maps
                </a>
                {address && (
                    <button
                        type="button"
                        onClick={copyAddress}
                        className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-canvas"
                    >
                        Copy address
                    </button>
                )}
                <a
                    href={directionsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-action hover:underline"
                >
                    Directions
                </a>
            </div>
        </div>
    );
}
