interface Props {
    location?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    size?: 'sm' | 'md';
}

export default function LocationBadge({ location, latitude, longitude, size = 'md' }: Props) {
    const sizeClass = size === 'sm' ? 'w-3.5 h-3.5' : 'w-5 h-5';
    const iconSize = size === 'sm' ? 9 : 12;

    if (latitude != null && longitude != null) {
        return (
            <span
                className={`inline-flex items-center justify-center ${sizeClass} rounded-full bg-emerald-50 text-emerald-600 cursor-default shrink-0`}
                title="Location resolved"
            >
                <svg width={iconSize} height={iconSize} viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </span>
        );
    }
    if (location) {
        return (
            <span
                className={`inline-flex items-center justify-center ${sizeClass} rounded-full bg-amber-50 text-amber-600 cursor-default shrink-0`}
                title="Location not resolved"
            >
                <svg width={iconSize} height={iconSize} viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6 3.5V6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="6" cy="8.5" r="0.75" fill="currentColor" />
                </svg>
            </span>
        );
    }
    return (
        <span
            className={`inline-flex items-center justify-center ${sizeClass} rounded-full bg-slate-100 text-slate-400 cursor-default shrink-0`}
            title="No location"
        >
            <svg width={iconSize} height={iconSize} viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 6H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        </span>
    );
}
