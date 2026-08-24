import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { InterestProfile } from '../api';
import AreaEditor from './AreaEditor';

vi.mock('./AreaMapPicker', () => ({
    default: () => <div data-testid="area-map-picker" />,
}));

function profile(id: number, label: string, areaLabel: string): InterestProfile {
    return {
        id,
        label,
        area_label: areaLabel,
        min_lat: 40,
        min_lng: 1,
        max_lat: 42,
        max_lng: 3,
        dance_tag_ids: [],
        reach_tag_ids: [],
        matches_enabled: false,
        notify_enabled: false,
        is_active: id === 1,
        created_at: '2026-01-01T00:00:00Z',
    };
}

describe('AreaEditor profile areas', () => {
    it('omits the generic my-area chip when it duplicates a profile area', async () => {
        const onApply = vi.fn();
        const profiles = [
            profile(1, 'Local salsa', 'Barcelona'),
            profile(2, 'Festival trips', 'Catalonia'),
        ];

        render(
            <AreaEditor
                value={{ label: 'Barcelona', min_lat: 40, min_lng: 1, max_lat: 42, max_lng: 3 }}
                myArea={{ label: 'Barcelona', min_lat: 40, min_lng: 1, max_lat: 42, max_lng: 3 }}
                profileAreas={profiles}
                onApply={onApply}
            />,
        );

        const firstProfileChip = screen.getByTestId('area-editor-profile-area-1');
        const secondProfileChip = screen.getByTestId('area-editor-profile-area-2');

        expect(firstProfileChip).toHaveTextContent("BarcelonaFrom your 'Local salsa' profile");
        expect(secondProfileChip).toHaveTextContent("CataloniaFrom your 'Festival trips' profile");
        expect(screen.queryByTestId('area-editor-my-area')).not.toBeInTheDocument();
        expect(firstProfileChip).toHaveAttribute('aria-pressed', 'true');
        expect(secondProfileChip).toHaveAttribute('aria-pressed', 'false');

        await userEvent.click(secondProfileChip);
        expect(onApply).toHaveBeenCalledWith({
            label: 'Catalonia',
            min_lat: 40,
            min_lng: 1,
            max_lat: 42,
            max_lng: 3,
        });
    });

    it('keeps the generic my-area chip when it is distinct from all profile areas', () => {
        const onApply = vi.fn();
        const profiles = [profile(1, 'Local salsa', 'Barcelona')];

        render(
            <AreaEditor
                value={{ label: 'Barcelona', min_lat: 40, min_lng: 1, max_lat: 42, max_lng: 3 }}
                myArea={{ label: 'Paris', min_lat: 48, min_lng: 2, max_lat: 49, max_lng: 3 }}
                profileAreas={profiles}
                onApply={onApply}
            />,
        );

        expect(screen.getByTestId('area-editor-profile-area-1')).toBeInTheDocument();
        expect(screen.getByTestId('area-editor-my-area')).toHaveTextContent('My area');
    });
});
