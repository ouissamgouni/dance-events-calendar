import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchEventsByIds,
    fetchInterestProfiles,
    fetchMe,
    fetchMyAttendingEvents,
    fetchMyPendingReviews,
    fetchMySavedEvents,
    fetchPassport,
    fetchPassportEvents,
} from '../api';
import type { CalendarEvent, PassportMilestone, PassportResponse } from '../types';
import { renderWithProviders } from '../test/render';
import MineHub, { closestMilestone } from './MineHub';

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>();
    return {
        ...actual,
        fetchEventsByIds: vi.fn(),
        fetchInterestProfiles: vi.fn(),
        fetchMe: vi.fn(),
        fetchMyAttendingEvents: vi.fn(),
        fetchMyPendingReviews: vi.fn(),
        fetchMySavedEvents: vi.fn(),
        fetchPassport: vi.fn(),
        fetchPassportEvents: vi.fn(),
    };
});

function event(eventId: string, title: string, startOffsetDays: number): CalendarEvent {
    const start = new Date(Date.now() + startOffsetDays * 86_400_000);
    return {
        event_id: eventId,
        calendar_id: 'calendar-1',
        title,
        description: null,
        image_url: '/should-not-render.jpg',
        location: 'Paris, France',
        latitude: 48.8566,
        longitude: 2.3522,
        start: start.toISOString(),
        end: new Date(start.getTime() + 10_800_000).toISOString(),
        all_day: false,
        color: null,
        view_count: 0,
        friends_going_count: 3,
        friends_going_preview: [],
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: false,
        links: null,
        tags: [],
    };
}

function milestone(overrides: Partial<PassportMilestone>): PassportMilestone {
    return {
        key: 'events_15',
        name: 'Dedicated',
        description: '',
        achieved_description: '',
        icon: '🏆',
        category: 'events',
        threshold: 15,
        unit: 'events',
        prestige: 10,
        progress: 13,
        unlocked: false,
        is_new: false,
        unlocked_at: null,
        ...overrides,
    };
}

const passport: PassportResponse = {
    stats: {
        total_events_attended: 13,
        cities_visited: 11,
        countries_visited: 7,
        reviews_written: 10,
        styles_danced: 2,
        top_style: 'Salsa',
        active_months_last_12: 5,
        active_months_this_year: 4,
        events_last_30_days: 1,
        avg_gap_days: 12,
        first_event_date: '2025-01-01T00:00:00Z',
        member_since: '2024-01-01T00:00:00Z',
        dancing_since: null,
    },
    collections: { cities: [], countries: [] },
    milestones: [milestone({})],
    consistency: null,
    monthly_activity: [{ month: '2026-08', count: 2 }],
};

describe('closestMilestone', () => {
    it('selects the locked milestone with the highest completion ratio', () => {
        const selected = closestMilestone([
            milestone({ key: 'events', progress: 13, threshold: 15 }),
            milestone({ key: 'cities', progress: 9, threshold: 10 }),
            milestone({ key: 'done', progress: 10, threshold: 10, unlocked: true }),
        ]);

        expect(selected?.key).toBe('cities');
    });

    it('keeps catalog order when completion ratios tie', () => {
        const selected = closestMilestone([
            milestone({ key: 'first', progress: 1, threshold: 2 }),
            milestone({ key: 'second', progress: 2, threshold: 4 }),
        ]);

        expect(selected?.key).toBe('first');
    });
});

describe('MineHub', () => {
    beforeEach(() => {
        vi.mocked(fetchMe).mockResolvedValue({
            user_id: 'user-1',
            email: 'alba@example.test',
            name: 'Alba',
            handle: 'alba',
            avatar_url: '/alba.jpg',
            onboarded_at: '2026-01-01T00:00:00Z',
        });
        vi.mocked(fetchMyAttendingEvents).mockResolvedValue([
            { event_id: 'later', share_publicly: true, share_audience: 'friends' },
            { event_id: 'next', share_publicly: true, share_audience: 'friends' },
            { event_id: 'past', share_publicly: true, share_audience: 'friends' },
        ]);
        vi.mocked(fetchMySavedEvents).mockResolvedValue([]);
        vi.mocked(fetchPassport).mockResolvedValue(passport);
        vi.mocked(fetchPassportEvents).mockResolvedValue([
            { ...event('attended', 'Attended', -10), city: 'Paris', country: 'France' },
        ]);
        vi.mocked(fetchMyPendingReviews).mockResolvedValue([
            { event_id: 'review-1', event_title: 'One', event_start: null, event_end: null, friend_proof: null },
            { event_id: 'review-2', event_title: 'Two', event_start: null, event_end: null, friend_proof: null },
        ]);
        vi.mocked(fetchInterestProfiles).mockResolvedValue([{}, {}, {}, {}] as never);
        vi.mocked(fetchEventsByIds).mockResolvedValue([
            event('later', 'Later Social', 20),
            event('past', 'Past Social', -1),
            event('next', 'Batignolles Bachata', 14),
        ]);
    });

    it('renders the approved sections with real counts and nearest future Going event', async () => {
        renderWithProviders(<MineHub />, { routerEntries: ['/mine'] });

        expect(await screen.findByText('Batignolles Bachata')).toBeInTheDocument();
        expect(screen.queryByText('Later Social')).not.toBeInTheDocument();
        expect(screen.queryByText('Past Social')).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Next up' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: '2 upcoming' })).toHaveAttribute('href', '/mine/calendar?filter=going');
        expect(screen.getByTestId('your-next-event-card')).toHaveAttribute('href', '/event/next');
        expect(screen.getByText('+3 friends going')).toBeInTheDocument();

        expect(screen.getByLabelText('My Events, 2 upcoming')).toHaveAttribute('href', '/mine/calendar?filter=going');
        expect(screen.getByLabelText('Passport, 13 events')).toHaveAttribute('href', '/mine/passport');
        expect(screen.getByLabelText('Saved searches, 4 searches')).toHaveAttribute('href', '/mine/profiles');
        expect(screen.getByLabelText('Reviews, 2 to review')).toHaveAttribute('href', '/mine/reviews');

        expect(screen.getByText('Dedicated')).toBeInTheDocument();
        expect(screen.getByText('13 / 15 events')).toBeInTheDocument();
        expect(screen.queryByText('Share your experience')).not.toBeInTheDocument();
        expect(screen.queryByText('Recent Activity')).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: /Batignolles Bachata/ })).not.toBeInTheDocument();
    });

    it('renders the shared next-event empty state', async () => {
        vi.mocked(fetchEventsByIds).mockResolvedValue([]);

        renderWithProviders(<MineHub />, { routerEntries: ['/mine'] });

        expect(await screen.findByText('No upcoming events')).toBeInTheDocument();
        expect(screen.getByText('Find your next dance event')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Explore →' })).toHaveAttribute('href', '/');
        expect(screen.queryByText('No upcoming events yet.')).not.toBeInTheDocument();
    });
});
