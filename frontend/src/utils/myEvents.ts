import type { CalendarEvent } from '../types';

export type MyEventsTab = 'upcoming' | 'saved' | 'past';
export type MyEventsView = 'list' | 'calendar' | 'map';

export interface MyEventsMonthGroup {
    key: string;
    label: string;
    events: CalendarEvent[];
}

export interface SequencedEvent {
    event: CalendarEvent;
    sequence: number;
}

export type JourneyPoint = [number, number];

export interface JourneyLeg {
    path: JourneyPoint[];
    arrow: JourneyPoint[];
}

export function initialMyEventsTab(search: string): MyEventsTab {
    const params = new URLSearchParams(search);
    const tab = params.get('tab');
    if (tab === 'saved' || tab === 'past' || tab === 'upcoming') return tab;
    return params.get('filter') === 'saved' ? 'saved' : 'upcoming';
}

export function eventsForMyEventsTab(
    events: CalendarEvent[],
    tab: MyEventsTab,
    isSaved: (eventId: string) => boolean,
    isAttending: (eventId: string) => boolean,
    now = Date.now(),
): CalendarEvent[] {
    return events
        .filter((event) => {
            const isPast = new Date(event.end).getTime() < now;
            if (tab === 'saved') return !isPast && isSaved(event.event_id);
            if (tab === 'past') return isPast && isAttending(event.event_id);
            return !isPast && isAttending(event.event_id);
        })
        .sort((left, right) => {
            const diff = new Date(left.start).getTime() - new Date(right.start).getTime();
            return tab === 'past' ? -diff : diff;
        });
}

export function groupMyEventsByMonth(events: CalendarEvent[]): MyEventsMonthGroup[] {
    const groups = new Map<string, MyEventsMonthGroup>();
    for (const event of events) {
        const start = new Date(event.start);
        const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
        const existing = groups.get(key);
        if (existing) {
            existing.events.push(event);
            continue;
        }
        groups.set(key, {
            key,
            label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
            events: [event],
        });
    }
    return [...groups.values()];
}

export function sequenceMappableEvents(events: CalendarEvent[]): SequencedEvent[] {
    return events
        .filter((event) => event.latitude != null && event.longitude != null)
        .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime())
        .map((event, index) => ({ event, sequence: index + 1 }));
}

export function eventPlace(event: CalendarEvent): string | null {
    const structured = [event.city, event.country].filter(Boolean).join(', ');
    return structured || event.location;
}

export function buildJourneyLegs(events: CalendarEvent[]): JourneyLeg[] {
    const located = events.filter((event) => event.latitude != null && event.longitude != null);
    return located.slice(0, -1).map((event, index) => {
        const next = located[index + 1];
        const start: JourneyPoint = [event.latitude!, event.longitude!];
        const end: JourneyPoint = [next.latitude!, next.longitude!];
        const deltaLat = end[0] - start[0];
        const deltaLng = end[1] - start[1];
        const distance = Math.hypot(deltaLat, deltaLng) || 1;
        const direction = index % 2 === 0 ? 1 : -1;
        const offset = Math.min(distance * 0.16, 5) * direction;
        const control: JourneyPoint = [
            (start[0] + end[0]) / 2 - (deltaLng / distance) * offset,
            (start[1] + end[1]) / 2 + (deltaLat / distance) * offset,
        ];
        const pointAt = (time: number): JourneyPoint => {
            const inverse = 1 - time;
            return [
                inverse * inverse * start[0] + 2 * inverse * time * control[0] + time * time * end[0],
                inverse * inverse * start[1] + 2 * inverse * time * control[1] + time * time * end[1],
            ];
        };
        const path = Array.from({ length: 21 }, (_, pointIndex) => pointAt(pointIndex / 20));
        const tip = pointAt(0.86);
        const beforeTip = pointAt(0.8);
        const arrowLat = tip[0] - beforeTip[0];
        const arrowLng = tip[1] - beforeTip[1];
        const arrowLength = Math.hypot(arrowLat, arrowLng) || 1;
        const scale = Math.min(distance * 0.035, 0.7);
        const backLat = (-arrowLat / arrowLength) * scale;
        const backLng = (-arrowLng / arrowLength) * scale;
        const sideLat = (-arrowLng / arrowLength) * scale * 0.55;
        const sideLng = (arrowLat / arrowLength) * scale * 0.55;
        return {
            path,
            arrow: [
                [tip[0] + backLat + sideLat, tip[1] + backLng + sideLng],
                tip,
                [tip[0] + backLat - sideLat, tip[1] + backLng - sideLng],
            ],
        };
    });
}
