import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchProfileFlow from './SearchProfileFlow';
import type { InterestProfile } from '../api';
import type { TagGroup } from '../types';

// The editor step renders <ProfileEditor>, which mounts a Leaflet map that
// jsdom cannot run. Stub it so the name input + Save/Delete buttons remain
// testable without the map.
vi.mock('./ProfileEditor', () => ({
    default: () => <div data-testid="profile-editor-stub" />,
}));

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
        min_lat: 41,
        min_lng: 2,
        max_lat: 42,
        max_lng: 3,
        dance_tag_ids: [10, 11],
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
        profiles: [makeProfile()],
        selectedProfileId: 'custom' as number | 'custom',
        current: { area: { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 }, danceIds: [10], reachIds: [20] },
        currentAreaLabel: 'Barcelona',
        danceGroup,
        reachGroup,
        localTagId: null,
        onApplyProfile: vi.fn(),
        onUpdateDefault: vi.fn().mockResolvedValue(undefined),
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

    it('picker lists Custom and saved profiles', () => {
        render(<SearchProfileFlow {...baseProps()} initialStep="picker" />);
        expect(screen.getByTestId('search-profile-picker')).toBeInTheDocument();
        expect(screen.getByText('Custom')).toBeInTheDocument();
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

    it('save step "Update default profile" calls onUpdateDefault then onClose', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="save" />);
        await user.click(screen.getByTestId('search-profile-update-default'));
        expect(props.onUpdateDefault).toHaveBeenCalled();
        expect(props.onClose).toHaveBeenCalled();
    });

    it('create step saves a new profile via createProfile', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="picker" />);
        await user.click(screen.getByTestId('search-profile-create'));
        expect(screen.getByTestId('search-profile-editor')).toBeInTheDocument();
        await user.click(screen.getByTestId('search-profile-save-draft'));
        expect(props.createProfile).toHaveBeenCalledTimes(1);
        // Browse-created profiles default notifications OFF.
        expect(props.createProfile.mock.calls[0][0]).toMatchObject({ matches_enabled: false });
        expect(props.updateProfile).not.toHaveBeenCalled();
    });

    it('edit pencil opens the editor and updates the existing profile', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="picker" />);
        await user.click(screen.getByTestId('search-profile-edit-1'));
        expect(screen.getByTestId('search-profile-editor')).toBeInTheDocument();
        await user.click(screen.getByTestId('search-profile-save-draft'));
        expect(props.updateProfile).toHaveBeenCalledWith(1, expect.objectContaining({ label: 'Barcelona' }));
    });

    it('deleting from the editor confirms then calls deleteProfile', async () => {
        const props = baseProps();
        const user = userEvent.setup();
        render(<SearchProfileFlow {...props} initialStep="picker" />);
        await user.click(screen.getByTestId('search-profile-edit-1'));
        await user.click(screen.getByTestId('search-profile-delete'));
        // Confirm dialog appears; click its Delete action.
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        expect(props.deleteProfile).toHaveBeenCalledWith(1);
    });
});
