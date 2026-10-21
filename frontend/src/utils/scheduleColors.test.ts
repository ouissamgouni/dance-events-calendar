import { describe, expect, it } from 'vitest';
import type { ScheduleActivityType, ScheduleRoom } from '../types';
import { scheduleColor, sessionCellColors } from './scheduleColors';

const room: ScheduleRoom = { id: 1, venue_id: null, name: 'Salsa Room', color: 'pink', sort_order: 0 };
const bootcamp: ScheduleActivityType = { id: 2, name: 'Bootcamp', color: 'violet', sort_order: 0 };

describe('sessionCellColors', () => {
    it('colors cells by the schedule color mode', () => {
        expect(sessionCellColors(undefined, room, bootcamp)).toEqual({ cell: scheduleColor('pink').cell, stripe: null });
        expect(sessionCellColors('room', room, bootcamp)).toEqual({ cell: scheduleColor('pink').cell, stripe: null });
        expect(sessionCellColors('activity_type', room, bootcamp)).toEqual({ cell: scheduleColor('violet').cell, stripe: null });
        expect(sessionCellColors('activity_type_stripe', room, bootcamp)).toEqual({ cell: scheduleColor('pink').cell, stripe: scheduleColor('violet').accent });
    });

    it('keeps the room tint for sessions without an activity type', () => {
        expect(sessionCellColors('activity_type_stripe', room, undefined)).toEqual({ cell: scheduleColor('pink').cell, stripe: null });
        expect(sessionCellColors('activity_type', null, undefined)).toEqual({ cell: scheduleColor('slate').cell, stripe: null });
    });
});
