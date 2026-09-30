import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../types';
import {
    getAdminEventPanelClass,
    getAdminEventRowClass,
    getAdminEventStatus,
    getAdminEventStatusIcon,
    getBlockReasonLabel,
} from './adminEventStatus';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        event_id: 'evt-1',
        calendar_id: 'cal-1',
        title: 'Salsa Night',
        description: null,
        location: null,
        latitude: null,
        longitude: null,
        start: '2026-10-01T18:00:00Z',
        end: '2026-10-01T22:00:00Z',
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: null,
        links: [],
        tags: [],
        ...overrides,
    };
}

describe('admin event status presentation', () => {
    it('uses blocked status and surface ahead of hidden and pending', () => {
        const blocked = event({
            status: 'blocked',
            review_status: 'pending',
            is_hidden: true,
            is_blocked: true,
        });

        expect(getAdminEventStatus(blocked)).toBe('blocked');
        expect(getAdminEventRowClass(blocked)).toContain('bg-admin-blocked');
        expect(getAdminEventPanelClass(blocked)).toBe('bg-admin-blocked');
        expect(getAdminEventStatusIcon(blocked)).toBe('/blocked.png');
    });

    it('uses hidden surface ahead of pending without changing status', () => {
        const hiddenPending = event({ status: 'pending', is_hidden: true });

        expect(getAdminEventStatus(hiddenPending)).toBe('pending');
        expect(getAdminEventRowClass(hiddenPending)).toContain('bg-admin-hidden');
        expect(getAdminEventPanelClass(hiddenPending)).toBe('bg-admin-hidden');
        expect(getAdminEventStatusIcon(hiddenPending)).toBe('/hide.png');
    });

    it('labels typed block reasons', () => {
        expect(getBlockReasonLabel('duplicate')).toBe('Duplicate');
        expect(getBlockReasonLabel(null)).toBeNull();
    });
});
