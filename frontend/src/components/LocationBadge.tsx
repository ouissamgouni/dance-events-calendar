import { MapPin, MapPinOff } from 'lucide-react';

interface Props {
    location?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    size?: 'sm' | 'md';
}

export default function LocationBadge({ location, latitude, longitude, size = 'md' }: Props) {
    const iconClass = `shrink-0 cursor-default ${size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5'}`;

    if (latitude != null && longitude != null) {
        return (
            <span className="inline-flex text-success" title="Location resolved" aria-label="Location resolved" role="img">
                <MapPin className={iconClass} fill="currentColor" stroke="white" strokeWidth={1.5} aria-hidden="true" />
            </span>
        );
    }
    if (location) {
        return (
            <span className="inline-flex text-amber-600" title="Location not resolved" aria-label="Location not resolved" role="img">
                <MapPinOff className={iconClass} aria-hidden="true" />
            </span>
        );
    }
    return (
        <span className="inline-flex text-muted opacity-60" title="No location" aria-label="No location" role="img">
            <MapPinOff className={iconClass} aria-hidden="true" />
        </span>
    );
}
