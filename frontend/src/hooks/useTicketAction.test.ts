import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../types';
import { useTicketAction } from './useTicketAction';

vi.mock('../context/AuthContext', () => ({ useOptionalAuth: () => ({ user: { user_id: 'olive' } }) }));
vi.mock('../context/FeatureFlagsContext', () => ({ useOptionalFeatureFlags: () => ({ eventTicketsEnabled: true }) }));
vi.mock('../context/AttendingEventsContext', () => ({ useOptionalAttendingEvents: () => null }));
vi.mock('../context/EventAssetSummaryContext', () => ({ useEventAssetSummary: () => ({ ticket_count: 0, memory_count: 0, memory_thumbs: [], can_add_memory: false, memory_window_closes_at: null }) }));

const organizer = (userId: string) => ({ user_id: userId, handle: userId, display_name: userId, avatar_url: null, is_verified_organizer: true });
const event = { event_id: 'fest', title: 'Fest', start: '2099-01-01T20:00:00Z', end: '2099-01-02T02:00:00Z', ticket_likely: true } as CalendarEvent;

describe('useTicketAction', () => {
    it('never prompts the organizer for a ticket to their own event', () => {
        expect(renderHook(() => useTicketAction({ ...event, organizer: organizer('olive') })).result.current).toBeNull();
        expect(renderHook(() => useTicketAction({ ...event, organizer: organizer('someone-else') })).result.current).toMatchObject({ label: 'Add ticket', inline: true });
    });
});
