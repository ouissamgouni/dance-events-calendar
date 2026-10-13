import type { CalendarEvent } from '../types';

/** End of the local day `days` from now, or null when the horizon is off. */
export function anonHorizonEnd(days: number, now: Date = new Date()): Date | null {
    if (!(days > 0)) return null;
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    end.setHours(23, 59, 59, 999);
    return end;
}

export function isBeyondHorizon(event: Pick<CalendarEvent, 'start'>, horizonEnd: Date | null): boolean {
    return !!horizonEnd && new Date(event.start).getTime() > horizonEnd.getTime();
}

export function splitByHorizon<T extends Pick<CalendarEvent, 'start'>>(
    events: T[],
    horizonEnd: Date | null,
): { visible: T[]; lockedCount: number } {
    if (!horizonEnd) return { visible: events, lockedCount: 0 };
    const visible = events.filter((e) => !isBeyondHorizon(e, horizonEnd));
    return { visible, lockedCount: events.length - visible.length };
}

export function formatHorizonDate(horizonEnd: Date): string {
    return horizonEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
