import { useEffect, useMemo, useState } from 'react';
import EventMap from '../EventMap';
import MyEventsMapPreview from '../MyEventsMapPreview';
import { fetchAdminEventMapPoints, type AdminEventMapResult, type EventFilterParams } from '../../api';
import type { AdminEventStatus, CalendarEvent } from '../../types';
import {
    ADMIN_EVENT_STATUS_LABELS,
    ADMIN_EVENT_STATUS_PIN_COLORS,
    getAdminEventStatus,
} from '../../utils/adminEventStatus';

const STATUS_ORDER: AdminEventStatus[] = ['new', 'published', 'unpublished', 'cancelled', 'removed'];

const pinColorOf = (event: CalendarEvent) => ADMIN_EVENT_STATUS_PIN_COLORS[getAdminEventStatus(event)];

interface Props {
    /** Panel filters; paging/sort/group are ignored. */
    params: EventFilterParams;
    /** Bump to refetch without re-fitting the viewport. */
    reloadToken: number;
    onOpenEvent: (eventId: string) => void;
    onShowUngeolocated: () => void;
}

interface Loaded {
    key: string;
    paramsKey: string;
    result: AdminEventMapResult | null;
    fitSeq: number;
}

export default function AdminEventsMap({ params, reloadToken, onOpenEvent, onShowUngeolocated }: Props) {
    const paramsKey = JSON.stringify(params);
    const requestKey = `${paramsKey}#${reloadToken}`;
    const [loaded, setLoaded] = useState<Loaded>({ key: '', paramsKey: '', result: null, fitSeq: 0 });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [manualFit, setManualFit] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const done = (result: AdminEventMapResult | null) => {
            if (cancelled) return;
            setLoaded((prev) => ({
                key: requestKey,
                paramsKey,
                result,
                fitSeq: prev.paramsKey === paramsKey ? prev.fitSeq : prev.fitSeq + 1,
            }));
        };
        fetchAdminEventMapPoints(JSON.parse(paramsKey) as EventFilterParams).then(done, () => done(null));
        return () => { cancelled = true; };
    }, [paramsKey, requestKey]);

    const loading = loaded.key !== requestKey;
    const result = loaded.result;
    const events = useMemo(() => result?.events ?? [], [result]);
    const statusCounts = useMemo(() => {
        const counts = new Map<AdminEventStatus, number>();
        for (const event of events) {
            const status = getAdminEventStatus(event);
            counts.set(status, (counts.get(status) ?? 0) + 1);
        }
        return counts;
    }, [events]);
    const index = events.findIndex((event) => event.event_id === selectedId);
    const selected = index >= 0 ? events[index] : null;
    const select = (next: number) => {
        const event = events[next];
        if (event) setSelectedId(event.event_id);
    };

    if (!result) {
        return (
            <div className="flex h-full items-center justify-center text-muted">
                <p className="text-xs">{loading ? 'Loading map…' : 'Failed to load the map.'}</p>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col" data-testid="admin-events-map">
            <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-card-line px-4 py-2 text-xs text-ink-soft">
                <span className="font-medium text-ink">
                    {result.total} on map
                    {loading && <span className="ml-2 font-normal text-muted">Updating…</span>}
                </span>
                {STATUS_ORDER.filter((status) => statusCounts.has(status)).map((status) => (
                    <span key={status} className="inline-flex items-center gap-1.5">
                        {/* eslint-disable-next-line no-restricted-syntax -- legend swatch mirrors the round pin */}
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ADMIN_EVENT_STATUS_PIN_COLORS[status] }} aria-hidden="true" />
                        {ADMIN_EVENT_STATUS_LABELS[status]} {statusCounts.get(status)}
                    </span>
                ))}
                {result.ungeolocated > 0 && (
                    <span>
                        {result.ungeolocated} not geolocated ·{' '}
                        <button type="button" onClick={onShowUngeolocated} className="font-medium text-action hover:underline">
                            Show them
                        </button>
                    </span>
                )}
            </div>
            {result.truncated && (
                <p className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-1.5 text-xs text-action" role="status">
                    Showing the first {events.length} of {result.total} events. Narrow the filters to see the rest.
                </p>
            )}
            {events.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-muted">
                    <p className="text-xs">No geolocated events match your filters.</p>
                </div>
            ) : (
                <div className="relative min-h-0 flex-1">
                    <EventMap
                        events={events}
                        disablePopups
                        minimalPopup
                        onMarkerSelect={(event) => setSelectedId(event.event_id)}
                        hoveredEventId={selectedId}
                        selectedEventId={selectedId}
                        fitAllToken={loaded.fitSeq + manualFit}
                        fitMarkersControl
                        showFollowingBadgeOverlay={false}
                        showTrendingOverlay={false}
                        pinColorOf={pinColorOf}
                    />
                </div>
            )}
            {selected && (
                <div className="shrink-0 bg-surface pb-[env(safe-area-inset-bottom)]">
                    <MyEventsMapPreview
                        event={selected}
                        hasPrevious={index > 0}
                        hasNext={index < events.length - 1}
                        onPrevious={() => select(index - 1)}
                        onNext={() => select(index + 1)}
                        onOpen={() => onOpenEvent(selected.event_id)}
                        onCollapse={() => {
                            setSelectedId(null);
                            setManualFit((n) => n + 1);
                        }}
                    />
                </div>
            )}
        </div>
    );
}
