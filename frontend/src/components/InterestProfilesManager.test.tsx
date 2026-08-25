import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fetchTagGroups, type InterestProfile } from '../api';
import InterestProfilesManager from './InterestProfilesManager';

const activateProfile = vi.fn().mockResolvedValue(undefined);
const deleteProfile = vi.fn().mockResolvedValue(undefined);
const createProfile = vi.fn().mockResolvedValue(undefined);
const updateProfile = vi.fn().mockResolvedValue(undefined);

const profiles: InterestProfile[] = [
    {
        id: 1,
        label: 'Summer Europe',
        area_label: 'Europe',
        geo_kind: 'area',
        min_lat: 24,
        min_lng: -18,
        max_lat: 69,
        max_lng: 50,
        center_lat: null,
        center_lng: null,
        radius_km: null,
        dance_tag_ids: [10],
        reach_filter: 'international',
        reach_tag_ids: [21],
        matches_enabled: true,
        notify_enabled: true,
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
    },
    {
        id: 2,
        label: 'Near home',
        area_label: 'Paris · 25 km',
        geo_kind: 'radius',
        min_lat: 48.6,
        min_lng: 2,
        max_lat: 49.1,
        max_lng: 2.7,
        center_lat: 48.8566,
        center_lng: 2.3522,
        radius_km: 25,
        dance_tag_ids: [10],
        reach_filter: 'any',
        reach_tag_ids: [],
        matches_enabled: true,
        notify_enabled: true,
        is_active: false,
        created_at: '2026-01-02T00:00:00Z',
    },
];

vi.mock('../hooks/useInterestProfiles', () => ({
    useInterestProfiles: () => ({
        profiles,
        error: null,
        setError: vi.fn(),
        createProfile,
        updateProfile,
        deleteProfile,
        activateProfile,
    }),
}));

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return {
        ...actual,
        fetchTagGroups: vi.fn(),
    };
});

function renderManager() {
    return render(
        <MemoryRouter initialEntries={['/mine/profiles']}>
            <Routes>
                <Route path="/mine/profiles" element={<InterestProfilesManager />} />
                <Route path="/mine/profiles/:profileId/edit" element={<p>Edit route</p>} />
            </Routes>
        </MemoryRouter>,
    );
}

describe('InterestProfilesManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fetchTagGroups).mockResolvedValue([
            { id: 1, slug: 'dance-style', label: 'Dance styles', tags: [{ id: 10, slug: 'salsa', label: 'Salsa' }] },
            { id: 2, slug: 'reach', label: 'Reach', tags: [{ id: 21, slug: 'international', label: 'International' }] },
        ] as never);
    });

    it('keeps card editing separate from management actions', async () => {
        const user = userEvent.setup();
        renderManager();

        await user.click(screen.getByRole('button', { name: 'Manage Near home' }));
        expect(screen.getByRole('button', { name: 'Set as default' })).toBeInTheDocument();
        expect(screen.queryByText('Edit route')).not.toBeInTheDocument();
    });

    it('opens a profile summary when the profile card is clicked', async () => {
        const user = userEvent.setup();
        renderManager();

        await user.click(await screen.findByRole('button', { name: /summer europe.*salsa.*international/i }));

        expect(screen.getByTestId('profile-draft-summary')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /dance styles.*salsa/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /area.*europe/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /reach.*international/i })).toBeInTheDocument();
    });

    it('confirms setting a non-default profile as default', async () => {
        const user = userEvent.setup();
        renderManager();

        await user.click(screen.getByRole('button', { name: 'Manage Near home' }));
        await user.click(screen.getByRole('button', { name: 'Set as default' }));
        expect(screen.getByText('This profile will be used automatically in Explore and for alerts.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Set as default' }));

        expect(activateProfile).toHaveBeenCalledWith(2);
    });

    it('blocks deletion of the Default profile', async () => {
        const user = userEvent.setup();
        renderManager();

        await user.click(screen.getByRole('button', { name: 'Manage Summer Europe' }));
        expect(screen.queryByRole('button', { name: 'Set as default' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete profile' }));

        expect(screen.getByText('To delete the default profile, set another profile as default first.')).toBeInTheDocument();
        expect(deleteProfile).not.toHaveBeenCalled();
    });

    it('duplicates a radius profile as non-default with its geography intact', async () => {
        const user = userEvent.setup();
        renderManager();

        await user.click(screen.getByRole('button', { name: 'Manage Near home' }));
        await user.click(screen.getByRole('button', { name: 'Duplicate' }));

        expect(createProfile).toHaveBeenCalledWith(expect.objectContaining({
            label: 'Near home copy',
            geo_kind: 'radius',
            center_lat: 48.8566,
            center_lng: 2.3522,
            radius_km: 25,
            is_active: false,
        }));
    });

    it('confirms deletion of a non-default profile', async () => {
        const user = userEvent.setup();
        renderManager();

        await user.click(screen.getByRole('button', { name: 'Manage Near home' }));
        await user.click(screen.getByRole('button', { name: 'Delete profile' }));
        expect(screen.getByText('This profile and its event alerts will be removed.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete' }));

        expect(deleteProfile).toHaveBeenCalledWith(2);
    });
});
