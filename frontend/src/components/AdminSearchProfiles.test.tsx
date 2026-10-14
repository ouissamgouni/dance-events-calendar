import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
    adminUpdateInterestProfile,
    fetchAdminInterestProfileClusters,
    fetchAdminInterestProfiles,
    fetchTagGroups,
    type AdminInterestProfileRow,
} from '../api';
import AdminSearchProfilesPanel from './AdminSearchProfiles';

vi.mock('../api', () => ({
    adminUpdateInterestProfile: vi.fn(),
    fetchAdminInterestProfileClusters: vi.fn(),
    fetchAdminInterestProfiles: vi.fn(),
    fetchTagGroups: vi.fn(),
}));
vi.mock('./AreaMapPreview', () => ({ default: () => <div /> }));

const row: AdminInterestProfileRow = {
    id: 7, label: 'Europe On2', area_label: 'Europe', geo_kind: 'area',
    min_lat: 24, min_lng: -18, max_lat: 69, max_lng: 50, center_lat: null, center_lng: null, radius_km: null,
    dance_tag_ids: [12], reach_filter: 'international', reach_tag_ids: [], matches_enabled: true,
    notify_enabled: true, is_active: true, created_at: '2026-10-01T00:00:00Z',
    cluster_key: '12|international|24,-18,69,50', user_id: 'u-1', user_email: 'nora@example.com',
    user_handle: 'nora', user_display_name: 'Nora', upcoming_match_count: 4, notifications_30d: 9,
} as AdminInterestProfileRow;

describe('AdminSearchProfilesPanel', () => {
    it('lists clusters, expands members and saves an edit for the user', async () => {
        const user = userEvent.setup();
        vi.mocked(fetchTagGroups).mockResolvedValue([{
            id: 1, slug: 'dance-style', label: 'Dance', tags: [
                { id: 10, slug: 'salsa', label: 'Salsa' },
                { id: 12, slug: 'mambo', label: 'On2', parent_tag_id: 10 },
                { id: 13, slug: 'cuban', label: 'Cuban', parent_tag_id: 10 },
            ],
        }] as never);
        vi.mocked(fetchAdminInterestProfileClusters).mockResolvedValue([{
            key: row.cluster_key, dance_tag_ids: [12], reach_filter: 'international',
            min_lat: 24, min_lng: -18, max_lat: 69, max_lng: 50, area_labels: ['Europe'],
            profile_count: 3, user_count: 3, matches_enabled_count: 2, upcoming_match_count: 4,
            notifications_30d_per_user: 9, flags: ['wide_area_any_reach'],
        }]);
        vi.mocked(fetchAdminInterestProfiles).mockResolvedValue([row]);
        vi.mocked(adminUpdateInterestProfile).mockResolvedValue(row);

        render(<MemoryRouter><AdminSearchProfilesPanel /></MemoryRouter>);

        const cluster = await screen.findByRole('button', { name: /On2/ });
        expect(cluster).toHaveTextContent('3 users · 2 alerts on');
        expect(cluster).toHaveTextContent('Wide area + any reach');
        await user.click(cluster);
        expect(fetchAdminInterestProfiles).toHaveBeenCalledWith({ clusterKey: row.cluster_key });

        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: /dance styles/i }));
        await user.click(within(dialog).getByRole('button', { name: 'Cuban' }));
        await user.click(within(dialog).getByRole('button', { name: /back/i }));
        await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(adminUpdateInterestProfile).toHaveBeenCalledWith(
            7, expect.objectContaining({ dance_tag_ids: [12, 13] }),
        ));
    });
});
