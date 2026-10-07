import { describe, expect, it } from 'vitest';
import {
    assetFileError,
    memoryStrip,
    rememberMemoryVisibility,
    rememberedMemoryVisibility,
    revealsAttendance,
    showMemoriesRow,
} from './eventAssets';

const summary = (overrides = {}) => ({
    ticket_count: 0,
    memory_count: 0,
    memory_thumbs: [],
    can_add_memory: false,
    memory_window_closes_at: null,
    ...overrides,
});

describe('assetFileError', () => {
    it('accepts PDFs and images for tickets but only images for memories', () => {
        expect(assetFileError({ type: 'application/pdf', size: 100 }, 'ticket', 5)).toBeNull();
        expect(assetFileError({ type: 'image/png', size: 100 }, 'ticket', 5)).toBeNull();
        expect(assetFileError({ type: 'application/pdf', size: 100 }, 'memory', 10)).toMatch(/Memories must be/);
        expect(assetFileError({ type: 'text/html', size: 100 }, 'ticket', 5)).toMatch(/Only PDF/);
        expect(assetFileError({ type: 'image/heic', size: 100 }, 'memory', 10)).toMatch(/Memories must be/);
    });

    it('caps PDF size but leaves images to the resize step', () => {
        expect(assetFileError({ type: 'application/pdf', size: 6 * 1024 * 1024 }, 'ticket', 5)).toBe('File is larger than 5MB');
        expect(assetFileError({ type: 'image/jpeg', size: 30 * 1024 * 1024 }, 'memory', 10)).toBeNull();
    });
});

describe('memoryStrip / showMemoriesRow', () => {
    it('shows up to three thumbs and counts the rest', () => {
        const thumbs = ['a', 'b', 'c'].map((id) => ({ id, thumb_url: id, visibility: 'private' as const }));
        expect(memoryStrip(summary({ memory_count: 5, memory_thumbs: thumbs }))).toEqual({ thumbs, extra: 2 });
        expect(memoryStrip(undefined)).toEqual({ thumbs: [], extra: 0 });
    });

    it('hides the row when there is nothing to show and uploads are closed', () => {
        expect(showMemoriesRow(summary())).toBe(false);
        expect(showMemoriesRow(summary({ can_add_memory: true }))).toBe(true);
        expect(showMemoriesRow(summary({ memory_count: 1 }))).toBe(true);
        expect(showMemoriesRow(undefined)).toBe(false);
    });
});

describe('memory sharing helpers', () => {
    it('warns only when sharing with attendees would reveal a non-public RSVP', () => {
        expect(revealsAttendance('attendees', 'friends')).toBe(true);
        expect(revealsAttendance('attendees', 'private')).toBe(true);
        expect(revealsAttendance('attendees', undefined)).toBe(true);
        expect(revealsAttendance('attendees', 'public')).toBe(false);
        expect(revealsAttendance('friends', 'private')).toBe(false);
    });

    it('shows the row for memories shared by others', () => {
        expect(showMemoriesRow(summary({ shared_memory_count: 2 }))).toBe(true);
    });

    it('remembers the last memory audience and ignores junk', () => {
        localStorage.removeItem('movida_memory_visibility');
        expect(rememberedMemoryVisibility()).toBe('friends');
        rememberMemoryVisibility('attendees');
        expect(rememberedMemoryVisibility()).toBe('attendees');
        localStorage.setItem('movida_memory_visibility', 'public');
        expect(rememberedMemoryVisibility()).toBe('friends');
    });
});
