/**
 * PassportShareCard — the off-screen, 9:16 surface we rasterise into a
 * shareable Story image (see utils/passportShareImage.ts). It is rendered
 * off-screen by the share flow, never shown inline, so its fixed 360×640 box
 * and dark styling are self-contained rather than inheriting the page theme.
 *
 * The map is an inline SVG (real Natural Earth coastlines, fit to the padded
 * bounding box of the event dots like Leaflet's fitBounds) because
 * html-to-image cannot capture a live Leaflet tile map.
 */
import { QRCodeSVG } from 'qrcode.react';
import { CARD_HEIGHT, CARD_WIDTH } from '../utils/passportShareImage';
import type { ScopedPassport } from '../utils/passportScope';
import {
    activityLevel,
    buildYearGrid,
    LEVEL_RAMP_DARK,
    MONTH_INITIALS,
    takeLastYears,
} from '../utils/passportActivity';
import { WORLD_LAND } from '../data/worldLand';
import { journeyBounds, journeyProjector, journeyRingIntersects } from '../utils/journeyMap';

interface PassportShareCardProps {
    displayName: string;
    handle: string | null;
    scoped: ScopedPassport;
    /** ISO date the dancer joined Movida — drives the all-time header line. */
    memberSince: string;
    /** ISO date the dancer started dancing — optional all-time subtitle. */
    dancingSince?: string | null;
    /** Profile URL encoded into the QR code (current-env origin). */
    profileUrl: string;
    /** Show the "Dancing since …" subtitle on the all-time card (off by default). */
    showDancingSince?: boolean;
    /** Honor the owner's "Sections to share" toggles. */
    showBadges?: boolean;
    showMap?: boolean;
    /** Render the activity heatmap (month strip on year cards, matrix on all-time). */
    showActivity?: boolean;
}

const MAP_W = 312;
const MAP_H = 130;

function monthYear(iso: string): string {
    try {
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    } catch {
        return iso;
    }
}

function yearOf(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : String(d.getFullYear());
}

/** Human-readable link label (`host/u/handle`) derived from the QR target. */
function linkLabel(profileUrl: string, handle: string | null): string {
    let host = 'joinmovida.com';
    try {
        host = new URL(profileUrl).host;
    } catch {
        // keep the default host
    }
    return handle ? `${host}/u/${handle}` : host;
}

function WorldMap({ coords }: { coords: { lat: number; lng: number }[] }) {
    const bounds = journeyBounds(coords);
    const project = journeyProjector(bounds, MAP_W, MAP_H);
    const land = WORLD_LAND.filter((ring) => journeyRingIntersects(ring, bounds));
    return (
        <svg
            width={MAP_W}
            height={MAP_H}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            style={{ display: 'block' }}
            aria-hidden
        >
            <defs>
                <clipPath id="passport-map-clip">
                    <rect x={0} y={0} width={MAP_W} height={MAP_H} />
                </clipPath>
            </defs>
            <rect x={0} y={0} width={MAP_W} height={MAP_H} fill="#1e293b" />
            <g clipPath="url(#passport-map-clip)">
                {land.map((ring, i) => (
                    <polygon
                        key={`land${i}`}
                        points={ring
                            .map(([lng, lat]) => {
                                const { x, y } = project(lat, lng);
                                return `${x.toFixed(1)},${y.toFixed(1)}`;
                            })
                            .join(' ')}
                        fill="#334155"
                        stroke="#3f4d63"
                        strokeWidth={0.5}
                    />
                ))}
                {coords.map((c, i) => {
                    const { x, y } = project(c.lat, c.lng);
                    return (
                        <g key={i}>
                            <circle cx={x} cy={y} r={5} fill="#3b82f6" opacity={0.25} />
                            <circle cx={x} cy={y} r={2.5} fill="#93c5fd" />
                        </g>
                    );
                })}
            </g>
        </svg>
    );
}

function StatCell({ value, label }: { value: number | string; label: string }) {
    return (
        <div style={{ flex: 1 }} className="border border-slate-700 bg-slate-800 px-2 py-3 text-center">
            <div className="text-2xl font-bold text-white tabular-nums leading-none">{value}</div>
            <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
        </div>
    );
}

// Year card: a single Jan–Dec row of intensity cells with month initials below.
function CardActivityStrip({ scoped }: { scoped: ScopedPassport }) {
    const rows = buildYearGrid(scoped.monthly);
    const cells = rows.length > 0 ? rows[rows.length - 1].cells : new Array(12).fill(0);
    return (
        <div>
            <div className="grid grid-cols-12 gap-1">
                {cells.map((count, i) => (
                    <div key={i} className={`aspect-square rounded-sm ${LEVEL_RAMP_DARK[activityLevel(count)]}`} />
                ))}
            </div>
            <div className="mt-1 grid grid-cols-12 gap-1 text-center text-[8px] leading-none text-ink-soft">
                {MONTH_INITIALS.map((m, i) => (
                    <span key={i}>{m}</span>
                ))}
            </div>
        </div>
    );
}

// All-time card: a compact Year × Month matrix, capped at the last 2 years so
// it never crowds the fixed-height card.
function CardActivityMatrix({ scoped }: { scoped: ScopedPassport }) {
    const rows = takeLastYears(buildYearGrid(scoped.monthly), 2);
    if (rows.length === 0) return null;
    return (
        <div>
            <div className="grid w-full gap-1" style={{ gridTemplateColumns: 'auto repeat(12, minmax(0, 1fr))' }}>
                <span />
                {MONTH_INITIALS.map((m, i) => (
                    <span key={`h-${i}`} className="text-center text-[8px] leading-none text-ink-soft">
                        {m}
                    </span>
                ))}
                {rows.map((row) => (
                    <CardMatrixRow key={row.year} year={row.year} cells={row.cells} />
                ))}
            </div>
        </div>
    );
}

function CardMatrixRow({ year, cells }: { year: number; cells: number[] }) {
    return (
        <>
            <span className="pr-1 text-right text-[9px] leading-none tabular-nums text-ink-soft">{year}</span>
            {cells.map((count, i) => (
                <div key={i} className={`aspect-square rounded-sm ${LEVEL_RAMP_DARK[activityLevel(count)]}`} />
            ))}
        </>
    );
}
export default function PassportShareCard({
    displayName,
    handle,
    scoped,
    memberSince,
    dancingSince = null,
    profileUrl,
    showDancingSince = false,
    showBadges = true,
    showMap = true,
    showActivity = true,
}: PassportShareCardProps) {
    const isYear = scoped.scope !== 'all';
    const isEmpty = scoped.totalEvents === 0;
    const headline = isYear
        ? isEmpty
            ? `No events yet in ${scoped.scope}`
            : `My ${scoped.scope} in Dance`
        : `Journey on Movida since ${monthYear(memberSince)}`;
    // Opt-in, all-time only: a small "Dancing since <year>" line under the name.
    const dancingSinceLine =
        !isYear && showDancingSince && dancingSince ? `Dancing since ${yearOf(dancingSince)}` : null;


    return (
        <div
            style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
            className="flex flex-col justify-between bg-slate-900 p-6 text-white"
        >
            <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
                    ✦ Movida · Dance Passport
                </div>
                <div className="mt-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h1 className="text-3xl font-bold leading-tight">{displayName}</h1>

                    </div>
                    <p className="mt-4 max-w-[90%] text-right text-sm font-medium leading-tight text-blue-300">
                        {headline}
                        {dancingSinceLine && (
                            <p className="mt-1 text-xs font-medium text-muted">{dancingSinceLine}</p>
                        )}
                    </p>
                </div>
            </div>

            {isEmpty ? (
                <div className="border border-slate-700 bg-slate-800 p-6 text-center">
                    <div className="text-4xl">💃</div>
                    <p className="mt-3 text-base font-semibold text-white">Just getting started</p>
                    <p className="mt-1 text-xs text-muted">
                        The dance journey begins. Follow along on Movida.
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {showMap && scoped.coords.length >= 2 && (
                        <div>
                            <WorldMap coords={scoped.coords} />
                        </div>
                    )}

                    {showActivity && scoped.monthly.length > 0 && (
                        isYear ? (
                            <CardActivityStrip scoped={scoped} />
                        ) : (
                            <CardActivityMatrix scoped={scoped} />
                        )
                    )}

                    <div className="flex gap-2">
                        <StatCell value={scoped.totalEvents} label="Events" />
                        <StatCell value={scoped.cities} label="Cities" />
                        <StatCell value={scoped.countries} label="Countries" />
                    </div>



                    {showBadges && scoped.badges.length > 0 && (
                        <div className="grid grid-cols-2 gap-2">
                            {scoped.badges.map((b) => (
                                <div
                                    key={b.key}
                                    className="flex items-start gap-2 border border-slate-700 bg-slate-800 px-2 py-2"
                                >
                                    <span className="text-lg leading-none">{b.icon}</span>
                                    <span className="min-w-0">
                                        <span className="block text-[11px] font-semibold leading-tight text-slate-100">
                                            {b.label}
                                            {b.tag && (
                                                <span className="ml-1 align-middle text-[8px] font-medium uppercase tracking-wide text-ink-soft">
                                                    {b.tag}
                                                </span>
                                            )}
                                        </span>
                                        {b.description && (
                                            <span className="mt-0.5 block text-[10px] leading-tight text-muted">
                                                {b.description}
                                            </span>
                                        )}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="flex items-center gap-3 border-t border-slate-700 pt-4">
                <div className="bg-surface p-1.5">
                    <QRCodeSVG value={profileUrl} size={44} level="M" />
                </div>
                <div className="min-w-0">
                    <p className="text-xs font-semibold text-white">Scan to see my dance journey</p>
                    <p className="truncate text-[11px] text-muted">{linkLabel(profileUrl, handle)}</p>
                </div>
            </div>
        </div>
    );
}
