/**
 * PassportShareCard — the off-screen, 9:16 surface we rasterise into a
 * shareable Story image (see utils/passportShareImage.ts). It is rendered
 * off-screen by the share flow, never shown inline, so its fixed 360×640 box
 * and dark styling are self-contained rather than inheriting the page theme.
 *
 * The map is a hand-drawn inline SVG (equirectangular projection of each
 * event's lat/lng) because html-to-image cannot capture a Leaflet map.
 */
import { QRCodeSVG } from 'qrcode.react';
import { CARD_HEIGHT, CARD_WIDTH } from '../utils/passportShareImage';
import type { ScopedPassport } from '../utils/passportScope';

interface PassportShareCardProps {
    displayName: string;
    handle: string | null;
    scoped: ScopedPassport;
    /** ISO date the dancer joined — shown on the all-time card. */
    memberSince: string;
    /** Public passport link encoded into the QR code. */
    shareUrl: string;
    /** Honor the owner's "Sections to share" toggles. */
    showBadges?: boolean;
    showMap?: boolean;
}

const MAP_W = 312;
const MAP_H = 150;
const GRATICULE_LNG = [-120, -60, 0, 60, 120];
const GRATICULE_LAT = [60, 30, 0, -30, -60];

function project(lat: number, lng: number): { x: number; y: number } {
    return {
        x: ((lng + 180) / 360) * MAP_W,
        y: ((90 - lat) / 180) * MAP_H,
    };
}

function monthYear(iso: string): string {
    try {
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    } catch {
        return iso;
    }
}

function WorldMap({ coords }: { coords: { lat: number; lng: number }[] }) {
    return (
        <svg
            width={MAP_W}
            height={MAP_H}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            style={{ display: 'block' }}
            aria-hidden
        >
            <rect x={0} y={0} width={MAP_W} height={MAP_H} fill="#1e293b" />
            {GRATICULE_LNG.map((lng) => {
                const { x } = project(0, lng);
                return <line key={`v${lng}`} x1={x} y1={0} x2={x} y2={MAP_H} stroke="#334155" strokeWidth={1} />;
            })}
            {GRATICULE_LAT.map((lat) => {
                const { y } = project(lat, 0);
                return <line key={`h${lat}`} x1={0} y1={y} x2={MAP_W} y2={y} stroke="#334155" strokeWidth={1} />;
            })}
            {coords.map((c, i) => {
                const { x, y } = project(c.lat, c.lng);
                return (
                    <g key={i}>
                        <circle cx={x} cy={y} r={5} fill="#3b82f6" opacity={0.25} />
                        <circle cx={x} cy={y} r={2.5} fill="#93c5fd" />
                    </g>
                );
            })}
        </svg>
    );
}

function StatCell({ value, label }: { value: number; label: string }) {
    return (
        <div style={{ flex: 1 }} className="border border-slate-700 bg-slate-800 px-2 py-3 text-center">
            <div className="text-2xl font-bold text-white tabular-nums leading-none">{value}</div>
            <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
        </div>
    );
}

export default function PassportShareCard({
    displayName,
    handle,
    scoped,
    memberSince,
    shareUrl,
    showBadges = true,
    showMap = true,
}: PassportShareCardProps) {
    const isYear = scoped.scope !== 'all';
    const isEmpty = scoped.totalEvents === 0;
    const subtitle = isYear
        ? isEmpty
            ? `No events yet in ${scoped.scope}`
            : `My ${scoped.scope} in Dance`
        : `Dancer since ${monthYear(memberSince)}`;
    const cadence =
        scoped.cadenceDays == null
            ? null
            : `1 event every ${scoped.cadenceDays} ${scoped.cadenceDays === 1 ? 'day' : 'days'}`;

    return (
        <div
            style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
            className="flex flex-col justify-between bg-slate-900 p-6 text-white"
        >
            <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    ✦ Movida · Dance Passport
                </div>
                <h1 className="mt-4 text-3xl font-bold leading-tight">{displayName}</h1>
                <p className="mt-1 text-sm font-medium text-blue-300">{subtitle}</p>
            </div>

            {isEmpty ? (
                <div className="border border-slate-700 bg-slate-800 p-6 text-center">
                    <div className="text-4xl">💃</div>
                    <p className="mt-3 text-base font-semibold text-white">Just getting started</p>
                    <p className="mt-1 text-xs text-slate-400">
                        The dance journey begins. Follow along on Movida.
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {showMap && scoped.coords.length >= 2 && (
                        <div>
                            <WorldMap coords={scoped.coords} />
                            {scoped.topCity && (
                                <p className="mt-2 text-xs text-slate-300">
                                    Most active in{' '}
                                    <span className="font-semibold text-white">{scoped.topCity}</span>
                                </p>
                            )}
                        </div>
                    )}

                    <div className="flex gap-2">
                        <StatCell value={scoped.totalEvents} label="Events" />
                        <StatCell value={scoped.cities} label="Cities" />
                        <StatCell value={scoped.countries} label="Countries" />
                    </div>
                    {cadence && (
                        <p className="text-center text-xs font-medium text-slate-300 tabular-nums">{cadence}</p>
                    )}

                    {showBadges && scoped.badges.length > 0 && (
                        <div className="grid grid-cols-2 gap-2">
                            {scoped.badges.map((b) => (
                                <div
                                    key={b.key}
                                    className="flex items-center gap-2 border border-slate-700 bg-slate-800 px-2 py-2"
                                >
                                    <span className="text-lg leading-none">{b.icon}</span>
                                    <span className="text-[11px] font-medium leading-tight text-slate-100">
                                        {b.label}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="flex items-center gap-3 border-t border-slate-700 pt-4">
                <div className="bg-white p-1.5">
                    <QRCodeSVG value={shareUrl} size={56} level="M" />
                </div>
                <div className="min-w-0">
                    <p className="text-xs font-semibold text-white">Scan to see my dance journey</p>
                    <p className="truncate text-[11px] text-slate-400">
                        joinmovida.com{handle ? ` · @${handle}` : ''}
                    </p>
                </div>
            </div>
        </div>
    );
}
