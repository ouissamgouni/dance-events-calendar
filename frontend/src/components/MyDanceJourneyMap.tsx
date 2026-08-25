import { WORLD_LAND } from '../data/worldLand';
import {
    journeyBounds,
    journeyProjector,
    journeyRingIntersects,
    type JourneyCoordinate,
} from '../utils/journeyMap';

const MAP_WIDTH = 320;
const MAP_HEIGHT = 140;

export default function MyDanceJourneyMap({ coords }: { coords: JourneyCoordinate[] }) {
    const bounds = journeyBounds(coords);
    const project = journeyProjector(bounds, MAP_WIDTH, MAP_HEIGHT);
    const land = WORLD_LAND.filter((ring) => journeyRingIntersects(ring, bounds));

    return (
        <svg
            viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
            className="block h-full w-full"
            role="img"
            aria-label={`${coords.length} attended event ${coords.length === 1 ? 'location' : 'locations'} on your journey map`}
            data-testid="mydance-journey-map"
        >
            <defs>
                <clipPath id="mydance-map-clip">
                    <rect width={MAP_WIDTH} height={MAP_HEIGHT} />
                </clipPath>
            </defs>
            <g clipPath="url(#mydance-map-clip)">
                {land.map((ring, index) => (
                    <polygon
                        key={`land-${index}`}
                        points={ring.map(([lng, lat]) => {
                            const point = project(lat, lng);
                            return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
                        }).join(' ')}
                        className="fill-white/12 stroke-white/10"
                        strokeWidth="0.7"
                    />
                ))}
                {coords.map((coordinate, index) => {
                    const point = project(coordinate.lat, coordinate.lng);
                    return (
                        <g key={`${coordinate.lat}-${coordinate.lng}-${index}`}>
                            <circle cx={point.x} cy={point.y} r="6" className="fill-white/20" />
                            <circle cx={point.x} cy={point.y} r="2.6" className="fill-white" />
                        </g>
                    );
                })}
            </g>
        </svg>
    );
}
