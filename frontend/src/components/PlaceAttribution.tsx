import type { GeocodeSuggestion } from '../api';
import { attributedProvider } from '../utils/placeFields';

const linkCls = 'underline hover:text-ink';

/** Credit line the place-search providers require next to their results. */
export default function PlaceAttribution({ results }: { results: GeocodeSuggestion[] }) {
    const provider = attributedProvider(results);
    if (!provider) return null;
    return (
        <p className="mt-2 text-xs text-muted">
            {provider === 'geoapify' ? (
                <>Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer" className={linkCls}>Geoapify</a></>
            ) : (
                <>Search by <a href="https://photon.komoot.io/" target="_blank" rel="noreferrer" className={linkCls}>Photon</a></>
            )}
            {' · © '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className={linkCls}>OpenStreetMap</a>
            {' contributors'}
        </p>
    );
}
