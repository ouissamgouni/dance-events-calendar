import type { ReactNode } from 'react';
import type { JourneyCoordinate } from '../utils/journeyMap';
import MyDanceJourneyMap from './MyDanceJourneyMap';
import MyDanceActivityStrip from './MyDanceActivityStrip';

interface PassportSummaryCardProps {
    displayName: string;
    handle: string | null;
    avatarUrl: string | null;
    eventsCount: number;
    citiesCount: number;
    countriesCount: number;
    coords: JourneyCoordinate[];
    monthlyActivity: Array<{ month: string; count: number }>;
    /** Slot for map overlay (e.g., top-right passport icon link). Positioned absolutely top-right of map. */
    mapOverlay?: ReactNode;
    /** Slot for bottom footer row (e.g., "Dancing since" info). Full-width at bottom. */
    footer?: ReactNode;
    /** Slot for actions (e.g., share button). Stacks below the footer on narrow screens. */
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
            <div className="relative min-h-20">
                <div className="absolute inset-y-0 right-0 w-2/3 opacity-90 md:w-2/5">
                    {mapOverlay && <div className="absolute right-1 top-1 z-20">{mapOverlay}</div>}
                    <MyDanceJourneyMap coords={coords} />
                </div>

                <div className="relative z-10">
                    <div className={mapOverlay
                        ? 'flex items-start gap-2 pr-12'
                        : 'flex items-start gap-2'}
                    >
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
                            <h1 className="break-words text-2xl font-bold">{displayName}</h1>
                            {handle && <p className="mt-1 break-words text-xs text-white/80">@{handle}</p>}
                        </div>
                    </div>

                    <div className="mt-2 flex flex-col gap-1">
                        <div className="text-sm font-bold leading-none">{eventsCount} Events</div>
                        {(citiesCount > 0 || countriesCount > 0) && (
                            <div className="text-xs font-semibold text-white/80">
                                <span>{citiesCount} {citiesCount === 1 ? 'city' : 'cities'}</span>
                                <span aria-hidden="true"> · </span>
                                <span>{countriesCount} {countriesCount === 1 ? 'country' : 'countries'}</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="mt-3 w-full md:w-[45%] md:pr-4">
                <div className="w-full min-w-0 opacity-90">
                    <MyDanceActivityStrip months={monthlyActivity} size="xs" />
                </div>
            </div>

            {(footer || actions) && (
                <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-white/20 pt-3">
                    {footer && <div className="min-w-0 flex-[1_1_18rem]">{footer}</div>}
                    {actions && <div className="ml-auto shrink-0">{actions}</div>}
                </div>
            )}
        </header>
    );
}
