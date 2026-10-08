import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAspectTagGroups, fetchAudienceTagGroups, fetchEventsByIds, fetchFollowingReviews, fetchMyPendingReviews, fetchMyRatings } from '../api';
import MyReviewsPage from './MyReviewsPage';
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext';

vi.mock('../api', () => ({
    fetchAspectTagGroups: vi.fn(),
    fetchAudienceTagGroups: vi.fn(),
    fetchEventsByIds: vi.fn(),
    fetchFollowingReviews: vi.fn(),
    fetchMyPendingReviews: vi.fn(),
    fetchMyRatings: vi.fn(),
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Ouissam Gouni' } }) }));
vi.mock('../context/MyRatingsContext', () => ({
    useMyRating: () => null,
    useMyRatingsLoaded: () => true,
    useUpsertMyRating: () => vi.fn(),
}));
vi.mock('../context/RatingAggregatesContext', () => ({
    useRatingAggregate: () => null,
    useInvalidateRatingAggregate: () => vi.fn(),
}));

describe('MyReviewsPage', () => {
    beforeEach(() => {
        vi.mocked(fetchAspectTagGroups).mockResolvedValue([]);
        vi.mocked(fetchAudienceTagGroups).mockResolvedValue([]);
        vi.mocked(fetchMyPendingReviews).mockResolvedValue([{
            event_id: 'pending-1', event_title: 'Paris Salsa Marathon', event_start: '2026-09-20T18:00:00Z', event_end: '2026-09-21T02:00:00Z', event_location: 'Paris, France', event_city: 'Paris', event_country: 'France', friend_proof: 'Laura',
        }]);
        vi.mocked(fetchEventsByIds).mockResolvedValue([
            {
                event_id: 'pending-1', calendar_id: 'calendar-1', title: 'Paris Salsa Marathon', description: null, image_url: '/event.jpg', location: 'Paris, France', city: 'Paris', country: 'France', latitude: null, longitude: null, start: '2026-09-20T18:00:00Z', end: '2026-09-21T02:00:00Z', all_day: false, color: null, view_count: 0, price_min: null, price_max: null, price_currency: null, price_is_free: false, links: null, tags: [],
            },
            {
                event_id: 'reviewed-1', calendar_id: 'calendar-1', title: 'Berlin Salsa Week', description: null, image_url: '/reviewed.jpg', location: 'Berlin, Germany', city: 'Berlin', country: 'Germany', latitude: null, longitude: null, start: '2026-08-10T18:00:00Z', end: '2026-08-11T02:00:00Z', all_day: false, color: null, view_count: 0, price_min: null, price_max: null, price_currency: null, price_is_free: false, links: null, tags: [],
            },
        ]);
        vi.mocked(fetchMyRatings).mockResolvedValue([{
            id: 'rating-1', event_id: 'reviewed-1', event_title: 'Berlin Salsa Week', event_start: '2026-08-10T18:00:00Z', overall_sentiment: 'great', aspect_scores: {}, aspect_tag_ids: [], audience_tag_ids: [], comment: 'A lovely weekend.', comment_status: 'approved', is_anonymous: false, status: 'approved', created_at: '2026-08-12T12:00:00Z', updated_at: '2026-08-12T12:00:00Z',
        }]);
    });

    it('separates pending tasks from reviewed history', async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><FeatureFlagsContext.Provider value={{ flags: defaultFlags, updateFlag: vi.fn() }}><MyReviewsPage /></FeatureFlagsContext.Provider></MemoryRouter>);

        expect(await screen.findByText('Paris Salsa Marathon')).toBeInTheDocument();
        expect(screen.getByText('Paris, France')).toBeInTheDocument();
        expect(screen.queryByText('Paris, France, Paris, France')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Write a review' })).toBeInTheDocument();

        await user.click(screen.getByRole('tab', { name: 'Reviewed (1)' }));
        expect(await screen.findByTestId('reviewed-event-card')).toBeInTheDocument();
        expect(screen.getByText('Berlin, Germany')).toBeInTheDocument();
        expect(screen.getByText(/A lovely weekend/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit your review' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Write a review' })).not.toBeInTheDocument();
    });

    it('keeps the compact reviewed fallback when event details are unavailable', async () => {
        const user = userEvent.setup();
        vi.mocked(fetchEventsByIds).mockResolvedValue([]);

        render(<MemoryRouter><FeatureFlagsContext.Provider value={{ flags: defaultFlags, updateFlag: vi.fn() }}><MyReviewsPage /></FeatureFlagsContext.Provider></MemoryRouter>);

        await user.click(await screen.findByRole('tab', { name: 'Reviewed (1)' }));
        expect(screen.getByText('A lovely weekend.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Berlin Salsa Week/ })).toBeInTheDocument();
        expect(screen.queryByTestId('reviewed-event-card')).not.toBeInTheDocument();
    });

    it('shows reviews from people you follow in the Tribe tab', async () => {
        const user = userEvent.setup();
        vi.mocked(fetchFollowingReviews).mockResolvedValue({
            items: [{
                id: 'tribe-1', event_id: 'event-9', event_title: 'Lisbon Kizomba Fest', event_start: '2026-07-01T18:00:00Z', overall_sentiment: 'great', comment: 'Amazing DJs.', aspect_tags: [], audience_tags: [], reviewer_label: 'Laura M', created_at: '2026-07-03T12:00:00Z',
            }],
            total: 1,
        });

        render(<MemoryRouter><FeatureFlagsContext.Provider value={{ flags: defaultFlags, updateFlag: vi.fn() }}><MyReviewsPage /></FeatureFlagsContext.Provider></MemoryRouter>);

        expect(fetchFollowingReviews).not.toHaveBeenCalled();
        await user.click(screen.getByRole('tab', { name: 'My Tribe' }));
        expect(await screen.findByText('Amazing DJs.')).toBeInTheDocument();
        expect(screen.getByText('Laura M')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Lisbon Kizomba Fest/ })).toHaveAttribute('href', '/event/event-9');
    });
});
