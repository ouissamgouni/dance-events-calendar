import type { ReactNode } from 'react';
import type { MapCoord } from '../types';
import MyDanceJourneyMap from './MyDanceJourneyMap';
import MyDanceActivityStrip from './MyDanceActivityStrip';

interface PassportSummaryCardProps {
    displayName: string;
    handle: string | null;
    avatarUrl: string | null;
    eventsCount: number;
    citiesCount: number;
    countriesCount: number;
    coords: MapCoord[];
    monthlyActivity: Array<{ month: string; count: number }>;
    /** Slot for map overlay (e.g., top-right passport icon link). Positioned absolutely top-right of map. */
    mapOverlay?: ReactNode;
    /** Slot for bottom footer row (e.g., "Dancing since" info). Full-width at bottom. */
    footer?: ReactNode;
    /** Slot for actions (e.g., share button). Positioned absolutely bottom-right. */
    actions?: ReactNode;
}

export default function PassportSummaryCard({
    displayName,
    handle,
    avatarUrl,
    eventsCount,
    citiesCount,
    countriesCount,
    coords,
    monthlyActivity,
    mapOverlay,
    footer,
    actions,
}: PassportSummaryCardProps) {
    return (
        <header className="relative overflow-hidden rounded-card bg-brand-strong p-4 text-white shadow-sm">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                {/* Left column: Avatar, name, stats */}
                <div className="flex flex-col gap-1">
                    <div className="relative z-10 flex items-center gap-2">
                        {avatarUrl ? (
                            <img
                                src={avatarUrl}
                                alt=""
                                className="h-12 w-12 shrink-0 rounded-full border-[3px] border-white/40 object-cover"
                                referrerPolicy="no-referrer"
                            />
                        ) : (
                            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/20 text-lg font-bold">
                                {displayName.charAt(0).toUpperCase()}
                            </span>
                        )}
                        <div className="min-w-0">
                            <h1 className="truncate text-2xl font-bold">{displayName}</h1>
                            {handle && <p className="mt-1 truncate text-sm text-white/80">@{handle}</p>}
                        </div>
                    </div>
                    <div className="relative z-10 text-sm font-bold leading-none">{eventsCount}</div>
                    {(citiesCount > 0 || countriesCount > 0) && (
                        <div className="relative z-10 text-xs font-semibold text-white/80">
                            <span>{citiesCount} {citiesCount === 1 ? 'city' : 'cities'}</span>
                            <span aria-hidden="true"> · </span>
                            <span>{countriesCount} {countriesCount === 1 ? 'country' : 'countries'}</span>
                        </div>
                    )}
                </div>

                {/* Right column: Map miniature + activity strip */}
                <div className="min-w-0 opacity-90 flex flex-col gap-0.5">
                    <div className="relative h-20">
                        {mapOverlay && <div className="absolute right-1 top-1 z-20">{mapOverlay}</div>}
                        <MyDanceJourneyMap coords={coords} />
                    </div>
                    <MyDanceActivityStrip months={monthlyActivity} size="xs" />
                </div>
            </div>

            {/* Footer row (full-width, below map/stats) */}
            {footer && (
                <div className="mt-3 border-t border-white/20 pt-3">
                    {footer}
                </div>
            )}

            {/* Actions (share button, etc.) */}
            {actions && (
                <div className="absolute bottom-4 right-4 z-[9000]">
                    {actions}
                </div>
            )}
        </header>
    );
}
