interface Props {
    location?: string | null;
    latitude?: number | null;
    longitude?: number | null;
}

export default function LocationBadge({ location, latitude, longitude }: Props) {
    if (latitude != null && longitude != null) {
        return (
            <span
                className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-50 text-emerald-600 cursor-default"
                title="Location resolved"
            >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </span>
        );
    }
    if (location) {
        return (
            <span
                className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-50 text-amber-600 cursor-default"
                title="Location not resolved"
            >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6 3.5V6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="6" cy="8.5" r="0.75" fill="currentColor" />
                </svg>
            </span>
        );
    }
    return (
        <span
            className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-slate-400 cursor-default"
            title="No location"
        >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 6H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        </span>
    );
}
