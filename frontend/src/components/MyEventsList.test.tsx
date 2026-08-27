import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext';
import { MyRatingsProvider } from '../context/MyRatingsContext';
import { renderWithProviders } from '../test/render';
import { makeUser } from '../test/handlers';
import { server } from '../test/server';
import type { CalendarEvent, MyRating, TagGroup } from '../types';
import MyEventsList from './MyEventsList';

function event(id: string, imageUrl: string | null): CalendarEvent {
    return {
        event_id: id,
        calendar_id: 'cal',
        title: `Event ${id}`,
        description: null,
        image_url: imageUrl,
        location: 'Paris, France',
        city: 'Paris',
        country: 'France',
        latitude: 48.8,
        longitude: 2.3,
        start: '2026-09-05T20:00:00Z',
        end: '2026-09-05T22:00:00Z',
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: true,
        links: null,
        tags: [],
    };
}

function renderList(tab: 'upcoming' | 'saved' | 'past', events: CalendarEvent[], onEventClick = vi.fn()) {
    return renderWithProviders(
        <FeatureFlagsProvider>
            <MyRatingsProvider>
                <MyEventsList events={events} tab={tab} onEventClick={onEventClick} />
            </MyRatingsProvider>
        </FeatureFlagsProvider>,
        { routerEntries: ['/mine/calendar'] },
    );
}

function rating(overrides: Partial<MyRating> = {}): MyRating {
    return {
        id: 'rating-one',
        event_id: 'reviewed',
        event_title: 'Event reviewed',
        event_start: '2026-09-05T20:00:00Z',
        overall_sentiment: 'amazing',
        aspect_scores: {},
        aspect_tag_ids: [11, 12],
        audience_tag_ids: [13],
        comment: 'The energy was fantastic and everyone made the night feel welcoming from beginning to end.',
        comment_status: 'approved',
        is_anonymous: false,
        status: 'approved',
        created_at: '2026-09-06T00:00:00Z',
        updated_at: '2026-09-06T00:00:00Z',
        ...overrides,
    };
}

function reviewGroups(): TagGroup[] {
    return [{
        id: 1,
        slug: 'review-tags',
        label: 'Review tags',
        color: null,
        ordinal: 1,
        allow_multiple: true,
        enabled: true,
        onboarding_eligible: false,
        tags: [
            { id: 11, slug: 'friendly', label: 'Friendly crowd', color: null, ordinal: 1, group_slug: 'review-tags', group_label: 'Review tags', group_color: null, enabled: true, is_hero_filter: false, hero_ordinal: null },
            { id: 12, slug: 'djs', label: 'Great DJs', color: null, ordinal: 2, group_slug: 'review-tags', group_label: 'Review tags', group_color: null, enabled: true, is_hero_filter: false, hero_ordinal: null },
            { id: 13, slug: 'music', label: 'Music lovers', color: null, ordinal: 3, group_slug: 'review-tags', group_label: 'Review tags', group_color: null, enabled: true, is_hero_filter: false, hero_ordinal: null },
        ],
    }];
}

describe('MyEventsList', () => {
    it('groups rows by month without map sequence numbers and shows Upcoming actions', () => {
        renderList('upcoming', [event('one', '/event.jpg'), event('two', null)]);

        expect(screen.getByText('September 2026')).toBeInTheDocument();
        expect(screen.getAllByTestId('my-events-row')).toHaveLength(2);
        expect(screen.getAllByTestId('event-card-image')).toHaveLength(1);
        expect(screen.queryByText('#1')).not.toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Save event' }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole('button', { name: "I'm going" }).length).toBeGreaterThan(0);
    });

    it('removes a failed image and shows compact Saved actions', () => {
        renderList('saved', [event('saved', '/broken.jpg')]);

        fireEvent.error(screen.getByTestId('event-card-image'));
        expect(screen.queryByTestId('event-card-image')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save event' })).toBeInTheDocument();
        const going = screen.getByRole('button', { name: "I'm going" });
        expect(going.querySelector('[data-icon-family="hand"]')).toBeInTheDocument();
    });

    it('shows a compact reviewed Past card with capped review tags and separate interactions', async () => {
        const onEventClick = vi.fn();
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/users/me/ratings', () => HttpResponse.json([rating()])),
            http.get('*/api/tags', () => HttpResponse.json(reviewGroups())),
            http.get('*/api/events/reviewed', () => HttpResponse.json(event('reviewed', '/event.jpg'))),
        );

        const { user } = renderList('past', [event('reviewed', '/event.jpg')], onEventClick);

        expect(await screen.findByText('Your review')).toBeInTheDocument();
        expect(screen.getByText('Amazing')).toBeInTheDocument();
        expect(screen.getByText(/The energy was fantastic/).parentElement).toHaveClass('line-clamp-2');
        expect(await screen.findByText('Friendly crowd')).toBeInTheDocument();
        expect(screen.getByText('Great DJs')).toBeInTheDocument();
        expect(screen.getByText('+1')).toBeInTheDocument();
        expect(screen.queryByTestId('event-card-image')).not.toBeInTheDocument();
        expect(screen.queryByTestId('attendee-avatar-stack')).not.toBeInTheDocument();
        expect(screen.getByText('SEP')).toHaveClass('text-ink-soft');

        await user.click(screen.getByRole('button', { name: 'Edit your review' }));
        expect(onEventClick).not.toHaveBeenCalled();
        expect(await screen.findByRole('dialog')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /Open Event reviewed/ }));
        expect(onEventClick).toHaveBeenCalledTimes(1);
    });

    it('shows Write a review without reserving comment or tag rows', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/users/me/ratings', () => HttpResponse.json([])),
            http.get('*/api/tags', () => HttpResponse.json([])),
        );

        renderList('past', [event('unreviewed', null)]);

        expect(await screen.findByText('Write a review')).toBeInTheDocument();
        expect(screen.queryByText('Your review')).not.toBeInTheDocument();
        expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
    });

    it('shows only the impression for a review without a comment or tags', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/users/me/ratings', () => HttpResponse.json([
                rating({ event_id: 'reviewed', comment: null, aspect_tag_ids: [], audience_tag_ids: [] }),
            ])),
            http.get('*/api/tags', () => HttpResponse.json(reviewGroups())),
        );

        renderList('past', [event('reviewed', null)]);

        expect(await screen.findByText('Your review')).toBeInTheDocument();
        expect(screen.getByText('Amazing')).toBeInTheDocument();
        expect(screen.queryByText('Friendly crowd')).not.toBeInTheDocument();
        expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
        expect(screen.queryByText('Write a review')).not.toBeInTheDocument();
    });
});
