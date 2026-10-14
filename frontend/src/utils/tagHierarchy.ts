import type { Tag } from '../types';

type Linked = Pick<Tag, 'id'> & { parent_tag_id?: number | null };

/** Search selection: a selected child (On2) supersedes its parent (Salsa). */
export function dropSupersededParents(ids: Iterable<number>, tags: Linked[]): number[] {
    const list = Array.from(new Set(ids));
    const selected = new Set(list);
    const superseded = new Set<number>();
    for (const tag of tags) {
        if (tag.parent_tag_id != null && selected.has(tag.id)) superseded.add(tag.parent_tag_id);
    }
    return list.filter((id) => !superseded.has(id));
}

/**
 * Toggle ``tagId`` in a search selection. Siblings combine freely; picking a
 * child clears its parent and picking a parent clears its children.
 */
export function toggleSearchTag(ids: Iterable<number>, tagId: number, tags: Linked[]): number[] {
    const next = new Set(ids);
    if (next.has(tagId)) {
        next.delete(tagId);
        return Array.from(next);
    }
    const parentId = tags.find((t) => t.id === tagId)?.parent_tag_id;
    if (parentId != null) next.delete(parentId);
    for (const tag of tags) {
        if (tag.parent_tag_id === tagId) next.delete(tag.id);
    }
    next.add(tagId);
    return Array.from(next);
}

/** Reorder so each child directly follows its parent; other order is kept. */
export function orderFamilies<T extends Linked>(tags: T[]): T[] {
    const present = new Set(tags.map((t) => t.id));
    const isNestedChild = (t: T) => t.parent_tag_id != null && present.has(t.parent_tag_id);
    const out: T[] = [];
    for (const tag of tags) {
        if (isNestedChild(tag)) continue;
        out.push(tag);
        for (const child of tags) {
            if (child.parent_tag_id === tag.id) out.push(child);
        }
    }
    return out;
}

/** "All Salsa" for a parent with sub-styles in ``tags``; plain label otherwise. */
export function searchTagLabel(tag: Pick<Tag, 'id' | 'label'>, tags: Linked[]): string {
    return tags.some((t) => t.parent_tag_id === tag.id) ? `All ${tag.label}` : tag.label;
}
