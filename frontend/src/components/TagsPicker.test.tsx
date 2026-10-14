import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TagGroup } from '../types';
import TagsPicker from './TagsPicker';

const tag = (id: number, slug: string, label: string, parent_tag_id: number | null = null) => ({
    id, slug, label, parent_tag_id, color: null, ordinal: id, group_slug: 'dance-style', group_label: 'Dance',
    group_color: null, enabled: true, is_hero_filter: false, hero_ordinal: null,
});

const group: TagGroup = {
    id: 1, slug: 'dance-style', label: 'Dance', color: null, ordinal: 0, allow_multiple: true,
    enabled: true, onboarding_eligible: true,
    tags: [tag(1, 'salsa', 'Salsa'), tag(2, 'bachata', 'Bachata'), tag(3, 'mambo', 'On2', 1), tag(4, 'salsa-on1', 'On1', 1)],
};

describe('TagsPicker searchSelection', () => {
    it('shows the family together and lets a sub-style replace "All Salsa"', async () => {
        const onChange = vi.fn();
        render(
            <TagsPicker
                tagGroups={[group]}
                value={{ selectedTagIds: [1, 4], freeTexts: {} }}
                onChange={onChange}
                allowFreeText={false}
                searchable={false}
                hideGroupLabels
                searchSelection
            />,
        );
        expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
            '✓ All Salsa', 'On2', '✓ On1', 'Bachata',
        ]);
        await userEvent.click(screen.getByRole('button', { name: 'On2' }));
        expect(onChange.mock.calls[0][0].selectedTagIds.sort()).toEqual([3, 4]);
    });

    it('keeps flat toggling without searchSelection', async () => {
        const onChange = vi.fn();
        render(
            <TagsPicker
                tagGroups={[group]}
                value={{ selectedTagIds: [1], freeTexts: {} }}
                onChange={onChange}
                allowFreeText={false}
                searchable={false}
                hideGroupLabels
            />,
        );
        await userEvent.click(screen.getByRole('button', { name: 'On2' }));
        expect(onChange.mock.calls[0][0].selectedTagIds.sort()).toEqual([1, 3]);
    });
});
