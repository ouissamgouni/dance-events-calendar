import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TagGroup } from '../types';
import { bboxSearchArea } from '../utils/searchArea';
import ProfileDraftEditor from './ProfileDraftEditor';

vi.mock('./AreaMapPreview', () => ({ default: () => <div data-testid="area-preview" /> }));
vi.mock('./AreaEditor', () => ({ default: () => <div data-testid="area-editor" /> }));

const danceGroup = {
    id: 1,
    slug: 'dance-style',
    label: 'Dance styles',
    tags: [{ id: 10, slug: 'salsa', label: 'Salsa' }],
} as TagGroup;

describe('ProfileDraftEditor', () => {
    it('updates the generated name and saves the edited summary', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
            <ProfileDraftEditor
                mode="create"
                danceGroup={danceGroup}
                initialValue={{
                    area: bboxSearchArea({ label: 'Europe', min_lat: 24, min_lng: -18, max_lat: 69, max_lng: 50 }, 'preset'),
                    danceIds: [],
                    reachFilter: 'international',
                    matchesEnabled: true,
                }}
                onSave={onSave}
            />,
        );

        expect(screen.getByLabelText('Profile name')).toHaveValue('Any style · Europe · International');
        await user.click(screen.getByRole('button', { name: /dance styles/i }));
        await user.click(screen.getByRole('button', { name: 'Salsa' }));
        await user.click(screen.getByRole('button', { name: /profile summary/i }));
        expect(screen.getByLabelText('Profile name')).toHaveValue('Salsa · Europe · International');

        await user.click(screen.getByRole('button', { name: 'Create profile' }));
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            label: 'Salsa · Europe · International',
            area_label: 'Europe',
            geo_kind: 'area',
            dance_tag_ids: [10],
            reach_filter: 'international',
            matches_enabled: true,
        }));
    });
});
