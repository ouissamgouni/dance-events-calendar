import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { InterestProfile } from '../api';
import type { BboxSearchArea } from '../utils/searchArea';
import AreaEditor from './AreaEditor';

vi.mock('./SquareAreaMapEditor', () => ({
    default: ({ area, onChange, preserveLabel }: {
        area: BboxSearchArea;
        onChange: (area: BboxSearchArea) => void;
        preserveLabel?: boolean;
    }) => (
        <button
            type="button"
            data-testid="square-area-map-editor"
            data-preserve-label={String(Boolean(preserveLabel))}
            onClick={() => onChange({ ...area, label: 'Custom area', min_lat: area.min_lat + 0.1 })}
        >
            Adjust map
        </button>
    ),
}));

vi.mock('./RadiusAreaEditor', () => ({ default: () => <div data-testid="radius-area-editor" /> }));

function profile(id: number, label: string, areaLabel: string): InterestProfile {
    return {
        id,
        label,
        area_label: areaLabel,
        geo_kind: 'area',
        min_lat: 40,
        min_lng: 1,
        max_lat: 42,
        max_lng: 3,
        center_lat: null,
        center_lng: null,
        radius_km: null,
        dance_tag_ids: [],
        reach_filter: 'any',
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

        await userEvent.click(screen.getByRole('button', { name: /your areas/i }));
        const firstProfileChip = screen.getByTestId('area-editor-profile-area-1');
        const secondProfileChip = screen.getByTestId('area-editor-profile-area-2');

        expect(firstProfileChip).toHaveTextContent('BarcelonaFrom profile Local salsa');
        expect(secondProfileChip).toHaveTextContent('CataloniaFrom profile Festival trips');
        expect(screen.queryByTestId('area-editor-my-area')).not.toBeInTheDocument();
        expect(firstProfileChip).toHaveAttribute('aria-pressed', 'true');
        expect(secondProfileChip).toHaveAttribute('aria-pressed', 'false');

        await userEvent.click(secondProfileChip);
        expect(firstProfileChip).toHaveAttribute('aria-pressed', 'false');
        expect(secondProfileChip).toHaveAttribute('aria-pressed', 'true');
        expect(onApply).toHaveBeenCalledWith({
            label: 'Catalonia',
            min_lat: 40,
            min_lng: 1,
            max_lat: 42,
            max_lng: 3,
        });
    });

    it('keeps the generic my-area chip when it is distinct from all profile areas', async () => {
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

        await userEvent.click(screen.getByRole('button', { name: /your areas/i }));
        expect(screen.getByTestId('area-editor-profile-area-1')).toBeInTheDocument();
        expect(screen.getByTestId('area-editor-my-area')).toHaveTextContent('Paris');
    });

    it('renames an area below the map and preserves the name through map adjustments', async () => {
        const user = userEvent.setup();
        const onUseArea = vi.fn();
        render(
            <AreaEditor
                value={{ label: 'Barcelona', min_lat: 40, min_lng: 1, max_lat: 42, max_lng: 3 }}
                myArea={{ label: 'Barcelona', min_lat: 40, min_lng: 1, max_lat: 42, max_lng: 3 }}
                onUseArea={onUseArea}
                showSavedAreas={false}
                allowRename
            />,
        );

        const nameInput = screen.getByLabelText('Area name');
        expect(nameInput).toHaveValue('Barcelona');
        await user.clear(nameInput);
        await user.type(nameInput, 'My dance area');
        expect(onUseArea).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'My dance area' }));

        const mapEditor = screen.getByTestId('square-area-map-editor');
        expect(mapEditor).toHaveAttribute('data-preserve-label', 'true');
        await user.click(mapEditor);
        expect(onUseArea).toHaveBeenLastCalledWith(expect.objectContaining({
            label: 'My dance area',
            min_lat: 40.1,
        }));

        await user.clear(nameInput);
        await user.tab();
        expect(nameInput).toHaveValue('Custom area');
        expect(onUseArea).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Custom area' }));
    });
});
