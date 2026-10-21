import type { ScheduleActivityType, ScheduleRoom, SessionColorMode } from '../types';

export interface ScheduleColorClasses {
    pill: string;
    cell: string;
    header: string;
    /** Solid swatch for accent bars, stripes and legend dots. */
    accent: string;
}

export const SCHEDULE_COLORS: Record<string, ScheduleColorClasses> = {
    blue: { pill: 'bg-blue-100 text-blue-800', cell: 'border-blue-200 bg-blue-50', header: 'bg-blue-100 text-blue-900', accent: 'bg-blue-400' },
    amber: { pill: 'bg-amber-100 text-amber-900', cell: 'border-amber-200 bg-amber-50', header: 'bg-amber-100 text-amber-950', accent: 'bg-amber-400' },
    pink: { pill: 'bg-pink-100 text-pink-900', cell: 'border-pink-200 bg-pink-50', header: 'bg-pink-100 text-pink-950', accent: 'bg-pink-400' },
    brown: { pill: 'bg-orange-100 text-orange-950', cell: 'border-orange-200 bg-orange-50', header: 'bg-orange-100 text-orange-950', accent: 'bg-orange-700' },
    violet: { pill: 'bg-violet-100 text-violet-900', cell: 'border-violet-200 bg-violet-50', header: 'bg-violet-100 text-violet-950', accent: 'bg-violet-400' },
    emerald: { pill: 'bg-emerald-100 text-emerald-900', cell: 'border-emerald-200 bg-emerald-50', header: 'bg-emerald-100 text-emerald-950', accent: 'bg-emerald-400' },
    indigo: { pill: 'bg-indigo-100 text-indigo-900', cell: 'border-indigo-200 bg-indigo-50', header: 'bg-indigo-100 text-indigo-950', accent: 'bg-indigo-400' },
    orange: { pill: 'bg-orange-100 text-orange-900', cell: 'border-orange-200 bg-orange-50', header: 'bg-orange-100 text-orange-950', accent: 'bg-orange-400' },
    slate: { pill: 'bg-slate-100 text-slate-800', cell: 'border-slate-200 bg-slate-50', header: 'bg-slate-100 text-slate-900', accent: 'bg-slate-300' },
};

export function scheduleColor(color: string | null | undefined): ScheduleColorClasses {
    return SCHEDULE_COLORS[color ?? ''] ?? SCHEDULE_COLORS.blue;
}

export const SESSION_COLOR_MODES: Array<{ value: SessionColorMode; label: string }> = [
    { value: 'room', label: 'By room' },
    { value: 'activity_type', label: 'By activity type' },
    { value: 'activity_type_stripe', label: 'Activity type stripe' },
];

/** Cell tint and optional left stripe for a grid session, per the schedule's color mode. */
export function sessionCellColors(
    mode: SessionColorMode | undefined,
    room: ScheduleRoom | null | undefined,
    activityType: ScheduleActivityType | null | undefined,
): { cell: string; stripe: string | null } {
    const roomCell = scheduleColor(room?.color ?? 'slate').cell;
    if (!activityType || !mode || mode === 'room') return { cell: roomCell, stripe: null };
    const typeColor = scheduleColor(activityType.color);
    if (mode === 'activity_type') return { cell: typeColor.cell, stripe: null };
    return { cell: roomCell, stripe: typeColor.accent };
}
