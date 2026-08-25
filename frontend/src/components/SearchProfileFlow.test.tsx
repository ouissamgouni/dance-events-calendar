import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchProfileFlow from './SearchProfileFlow';
import type { InterestProfile } from '../api';
import type { TagGroup } from '../types';

vi.mock('./AreaMapPreview', () => ({ default: () => <div data-testid="area-preview" /> }));
vi.mock('./AreaEditor', () => ({ default: () => <div data-testid="area-editor" /> }));

const danceGroup: TagGroup = {
    id: 1,
    slug: 'dance-style',
    label: 'Dance styles',
    tags: [
        { id: 10, slug: 'salsa', label: 'Salsa' },
        { id: 11, slug: 'bachata', label: 'Bachata' },
    ],
} as unknown as TagGroup;

const reachGroup: TagGroup = {
    id: 2,
    slug: 'reach',
    label: 'Reach',
    tags: [{ id: 20, slug: 'international', label: 'International' }],
} as unknown as TagGroup;

function makeProfile(overrides: Partial<InterestProfile> = {}): InterestProfile {
    return {
        id: 1,
        label: 'Barcelona',
        area_label: 'Barcelona area',
        geo_kind: 'area',
        min_lat: 41,
        min_lng: 2,
        max_lat: 42,
        max_lng: 3,
        center_lat: null,
        center_lng: null,
        radius_km: null,
        dance_tag_ids: [10, 11],
        reach_filter: 'international',
        reach_tag_ids: [20],
        matches_enabled: false,
        notify_enabled: false,
        is_active: false,
        created_at: '2024-01-01T00:00:00Z',
        ...overrides,
    };
}

function baseProps() {
    return {
        open: true as const,
        onClose: vi.fn(),
        profiles: [makeProfile({ is_active: true }), makeProfile({ id: 2, label: 'Barcelona salsa' })],
        selectedProfileId: 'custom' as number | 'custom',
        current: { area: { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 }, danceIds: [10], reachFilter: 'international' as const, reachIds: [20] },
        currentAreaLabel: 'Barcelona',
        danceGroup,
        reachGroup,
        localTagId: null,
        onApplyProfile: vi.fn(),
        onUpdateProfile: vi.fn().mockResolvedValue(undefined),
        createProfile: vi.fn().mockResolvedValue(makeProfile()),
        updateProfile: vi.fn().mockResolvedValue(makeProfile()),
        deleteProfile: vi.fn().mockResolvedValue(undefined),
    };
}

describe('SearchProfileFlow', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders nothing when closed', () => {
        const { container } = render(<SearchProfileFlow {...baseProps()} open={false} initialStep="picker" />);
        expect(container).toBeEmptyDOMElement();
    });

    it('picker lists Current search for unmatched filters and saved profiles', () => {
        render(<SearchProfileFlow {...baseProps()} initialStep="picker" />);
        expect(screen.getByTestId('search-profile-picker')).toBeInTheDocument();
        expect(screen.getByText('Current search')).toBeInTheDocument();
        expect(screen.getByTestId('search-profile-apply-1')).toBeInTheDocument();
    });

    it('hides Current search when a saved profile is selected', () => {
        render(<SearchProfileFlow {...baseProps()} selectedProfileId={1} initialStep="picker" />);
        expect(screen.queryByText('Current search')).not.toBeInTheDocument();
        expect(screen.getByTestId('search-profile-apply-1')).toBeInTheDocument();
    });

    it('applying a saved profile calls onApplyProfile then onClose', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="picker" />);
        await user.click(screen.getByTestId('search-profile-apply-1'));
        expect(props.onApplyProfile).toHaveBeenCalledWith(props.profiles[0]);
        expect(props.onClose).toHaveBeenCalled();
    });

    it('save step preselects active profile and calls onUpdateProfile then onClose', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="save" />);
        // The active profile (id=1) should be preselected.
        await waitFor(() => expect(screen.getByTestId('search-profile-target-1')).toHaveAttribute('aria-pressed', 'true'));
        await user.click(screen.getByTestId('search-profile-update'));
        expect(props.onUpdateProfile).toHaveBeenCalledWith(props.profiles[0]);
        expect(props.onClose).toHaveBeenCalled();
    });

    it('save step allows selecting a different profile to update', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="save" />);
        // Initially the active profile is selected.
        await waitFor(() => expect(screen.getByTestId('search-profile-target-1')).toHaveAttribute('aria-pressed', 'true'));
        // Click the non-active profile.
        await user.click(screen.getByTestId('search-profile-target-2'));
        expect(screen.getByTestId('search-profile-target-2')).toHaveAttribute('aria-pressed', 'true');
        await user.click(screen.getByTestId('search-profile-update'));
        expect(props.onUpdateProfile).toHaveBeenCalledWith(props.profiles[1]);
        expect(props.onClose).toHaveBeenCalled();
    });

    it('save step with no profiles shows only create option', async () => {
        const props = baseProps();
        props.profiles = [];
        render(<SearchProfileFlow {...props} initialStep="save" />);
        // Profile selector should not be present.
        expect(screen.queryByText('Profile to update')).not.toBeInTheDocument();
        // But "Save as new profile" should be available.
        expect(screen.getByTestId('search-profile-save-new')).toBeInTheDocument();
    });

    it('create step saves a new profile via createProfile', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="picker" />);
        await user.click(screen.getByTestId('search-profile-create'));
        expect(screen.getByTestId('search-profile-editor')).toBeInTheDocument();
        expect(screen.getByLabelText('Profile name')).toHaveValue('Salsa · Barcelona · International');
        await user.clear(screen.getByLabelText('Profile name'));
        await user.type(screen.getByLabelText('Profile name'), 'Weekend salsa');
        await user.click(screen.getByTestId('profile-draft-save'));
        expect(props.createProfile).toHaveBeenCalledTimes(1);
        expect(props.createProfile.mock.calls[0][0]).toMatchObject({
            label: 'Weekend salsa',
            area_label: 'Barcelona',
            matches_enabled: false,
        });
        expect(props.onApplyProfile).toHaveBeenCalledWith(await props.createProfile.mock.results[0].value);
        expect(props.updateProfile).not.toHaveBeenCalled();
        expect(props.onClose).toHaveBeenCalled();
    });

    it('editing a non-selected profile updates it without applying it', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="picker" />);
        await user.click(screen.getByTestId('search-profile-edit-2'));
        expect(screen.getByTestId('search-profile-editor')).toBeInTheDocument();
        await user.click(screen.getByTestId('profile-draft-save'));
        expect(props.updateProfile).toHaveBeenCalledWith(2, expect.objectContaining({
            label: 'Barcelona salsa',
        }));
        expect(props.onApplyProfile).not.toHaveBeenCalled();
    });

    it('editing the selected profile reapplies the updated result', async () => {
        const props = baseProps();
        const updated = makeProfile({ label: 'Updated Barcelona' });
        props.selectedProfileId = 1;
        props.updateProfile.mockResolvedValue(updated);
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="picker" />);
        await user.click(screen.getByTestId('search-profile-edit-1'));
        await user.click(screen.getByTestId('profile-draft-save'));
        expect(props.onApplyProfile).toHaveBeenCalledWith(updated);
        expect(props.onClose).toHaveBeenCalled();
    });

    it('deleting from the editor confirms then calls deleteProfile', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="picker" />);
        await user.click(screen.getByTestId('search-profile-edit-1'));
        await user.click(screen.getByTestId('profile-draft-delete'));
        // Confirm dialog appears; click its Delete action.
        await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!);
        expect(props.deleteProfile).toHaveBeenCalledWith(1);
    });
});
