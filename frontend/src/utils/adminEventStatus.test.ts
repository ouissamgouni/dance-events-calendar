import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../types';
import {
    getAdminEventPanelClass,
    getAdminEventRowClass,
    getAdminEventStatus,
    getAdminEventStatusIcon,
    getRemovalReasonLabel,
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
    it('shows removed events as the trash', () => {
        const removed = event({ status: 'removed', status_reason: 'google_calendar', is_hidden: true });

        expect(getAdminEventStatus(removed)).toBe('removed');
        expect(getAdminEventRowClass(removed)).toContain('bg-admin-blocked');
        expect(getAdminEventPanelClass(removed)).toBe('bg-admin-blocked');
        expect(getAdminEventStatusIcon(removed)).toBe('/blocked.png');
        expect(getRemovalReasonLabel(removed)).toBe('Deleted in Google Calendar');
    });

    it('uses the hidden surface for unpublished events', () => {
        const hidden = event({ status: 'unpublished', is_hidden: true });

        expect(getAdminEventRowClass(hidden)).toContain('bg-admin-hidden');
        expect(getAdminEventPanelClass(hidden)).toBe('bg-admin-hidden');
        expect(getAdminEventStatusIcon(hidden)).toBe('/hide.png');
        expect(getRemovalReasonLabel(hidden)).toBeNull();
    });

    it('tints private events, below removed/unpublished/cancelled', () => {
        expect(getAdminEventRowClass(event({ status: 'new', visibility_state: 'private' }))).toContain('bg-violet-50');
        expect(getAdminEventPanelClass(event({ status: 'published', visibility_state: 'private' }))).toBe('bg-violet-50');
        expect(getAdminEventPanelClass(event({ status: 'unpublished', visibility_state: 'private' }))).toBe('bg-admin-hidden');
    });

    it('derives the status from legacy fields when missing', () => {
        expect(getAdminEventStatus(event({ is_blocked: true }))).toBe('removed');
        expect(getAdminEventStatus(event({ review_status: 'pending' }))).toBe('new');
        expect(getAdminEventStatus(event({ review_status: 'reviewed' }))).toBe('published');
    });
});
