import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../types';
import { describeRevisionValue, splitDraftChanges, withDraft } from './eventRevisions';

describe('eventRevisions', () => {
    it('stages content fields in the draft and keeps operational ones immediate', () => {
        const { draft, immediate } = splitDraftChanges({ title: 'New', location: 'B', calendar_id: 'c2', is_hidden: true });
        expect(draft).toEqual({ title: 'New', location: 'B' });
        expect(immediate).toEqual({ calendar_id: 'c2', is_hidden: true });
    });

    it('shows the draft values over the live event', () => {
        const event = { event_id: 'e', title: 'Live', location: 'A' } as CalendarEvent;
        const shown = withDraft(event, { title: { old: 'Live', new: 'Draft' } });
        expect(shown.title).toBe('Draft');
        expect(shown.location).toBe('A');
        expect(withDraft(event, null)).toBe(event);
    });

    it('formats empty, boolean and list values', () => {
        expect(describeRevisionValue('location', null)).toBe('—');
        expect(describeRevisionValue('all_day', true)).toBe('Yes');
        expect(describeRevisionValue('links', [{}, {}])).toBe('2 items');
    });
});
