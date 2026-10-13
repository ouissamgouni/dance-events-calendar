import type { CalendarEvent } from '../types';

export interface MapEventGroup {
    /** The date the pin stands for: the next upcoming one, else the latest. */
    event: CalendarEvent;
    members: CalendarEvent[];
}

/** One group per series and venue; events without a series_key stay alone. */
export function groupSeriesForMap(events: CalendarEvent[], now = Date.now()): MapEventGroup[] {
    const byKey = new Map<string, CalendarEvent[]>();
    for (const event of events) {
        const key = event.series_key
            ? `${event.series_key}@${event.latitude?.toFixed(5)},${event.longitude?.toFixed(5)}`
            : `event:${event.event_id}`;
        const members = byKey.get(key);
        if (members) members.push(event);
        else byKey.set(key, [event]);
    }
    return [...byKey.values()].map((members) => {
        const sorted = [...members].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        const event = sorted.find((e) => Date.parse(e.end) >= now) ?? sorted[sorted.length - 1];
        return { event, members: sorted };
    });
}
