import { describe, expect, it } from 'vitest';
import type { CalendarEvent, TagGroup } from '../types';
import { filterEventsByTags } from './tagFilter';
import { dropSupersededParents, orderFamilies, searchTagLabel, toggleSearchTag } from './tagHierarchy';

const SALSA = 1;
const ON1 = 2;
const ON2 = 3;
const BACHATA = 4;
const CUBAN = 5;
const tags = [
    { id: SALSA, label: 'Salsa', parent_tag_id: null },
    { id: BACHATA, label: 'Bachata', parent_tag_id: null },
    { id: ON1, label: 'On1', parent_tag_id: SALSA },
    { id: ON2, label: 'On2', parent_tag_id: SALSA },
    { id: CUBAN, label: 'Cuban', parent_tag_id: SALSA },
];

describe('dropSupersededParents', () => {
    it('drops the parent when a child is selected', () => {
        expect(dropSupersededParents([SALSA, ON2, BACHATA], tags)).toEqual([ON2, BACHATA]);
    });

    it('keeps the parent alone', () => {
        expect(dropSupersededParents([SALSA], tags)).toEqual([SALSA]);
    });

    it('is a no-op for flat taxonomies', () => {
        expect(dropSupersededParents([1, 2], [{ id: 1 }, { id: 2 }])).toEqual([1, 2]);
    });
});

describe('toggleSearchTag', () => {
    it('lets siblings combine', () => {
        expect(toggleSearchTag([ON1], ON2, tags).sort()).toEqual([ON1, ON2]);
    });

    it('picking a child clears its parent', () => {
        expect(toggleSearchTag([SALSA, BACHATA], ON2, tags).sort()).toEqual([ON2, BACHATA].sort());
    });

    it('picking the parent clears its children', () => {
        expect(toggleSearchTag([ON1, ON2, BACHATA], SALSA, tags).sort()).toEqual([SALSA, BACHATA].sort());
    });

    it('deselects a selected tag', () => {
        expect(toggleSearchTag([ON1, ON2], ON1, tags)).toEqual([ON2]);
    });
});

describe('orderFamilies', () => {
    it('places children right after their parent', () => {
        expect(orderFamilies(tags).map((t) => t.id)).toEqual([SALSA, ON1, ON2, CUBAN, BACHATA]);
    });

    it('keeps orphaned children when the parent is absent', () => {
        expect(orderFamilies(tags.filter((t) => t.id !== SALSA)).map((t) => t.id)).toEqual([BACHATA, ON1, ON2, CUBAN]);
    });
});

describe('searchTagLabel', () => {
    it('labels a parent with sub-styles as "All …"', () => {
        expect(searchTagLabel(tags[0], tags)).toBe('All Salsa');
        expect(searchTagLabel(tags[1], tags)).toBe('Bachata');
    });
});

describe('filterEventsByTags with sub-styles', () => {
    const group = { slug: 'dance-style', tags } as unknown as TagGroup;
    const event = (id: string, tagIds: number[]) =>
        ({ id, tags: tagIds.map((tid) => ({ id: tid })) }) as unknown as CalendarEvent;
    const events = [
        event('on2-night', [SALSA, ON2]),
        event('cuban-night', [SALSA, CUBAN]),
        event('unspecified-salsa', [SALSA]),
    ];
    const ids = (selected: number[]) =>
        filterEventsByTags(events, new Set(selected), [group]).map((e) => (e as unknown as { id: string }).id);

    it('legacy "Salsa + On2" selection behaves as On2 only', () => {
        expect(ids([SALSA, ON2])).toEqual(['on2-night']);
    });

    it('"All Salsa" matches the whole family', () => {
        expect(ids([SALSA])).toEqual(['on2-night', 'cuban-night', 'unspecified-salsa']);
    });

    it('On2 + Cuban matches either', () => {
        expect(ids([ON2, CUBAN])).toEqual(['on2-night', 'cuban-night']);
    });
});
