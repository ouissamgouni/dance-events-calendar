const CARTO_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO_BASEMAP_KEY = (import.meta.env.VITE_CARTO_BASEMAP_KEY as string | undefined)?.trim();

export const BASEMAP_CONFIG = {
    attribution: CARTO_BASEMAP_KEY ? CARTO_ATTRIBUTION : OSM_ATTRIBUTION,
    url: CARTO_BASEMAP_KEY
        ? `https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CARTO_BASEMAP_KEY)}`
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: CARTO_BASEMAP_KEY ? 'abcd' : 'abc',
    maxZoom: 20,
} as const;
