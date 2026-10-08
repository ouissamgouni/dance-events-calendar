import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlagsContext, defaultFlags } from '../context/FeatureFlagsContext';
import { MyRatingsProvider } from '../context/MyRatingsContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { renderWithProviders } from '../test/render';
import { makeUser } from '../test/handlers';
import { server } from '../test/server';
import type { CalendarEvent, MyRating, TagGroup } from '../types';
import MyEventsList from './MyEventsList';
import { ToastProvider } from './Toast';

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

function renderList(tab: 'upcoming' | 'saved' | 'past', events: CalendarEvent[], onEventClick = vi.fn(), scheduleEnabled = false, extraFlags: Partial<typeof defaultFlags> = {}) {
    // Pictures are behind a site setting; turn it on so the image assertions
    // below exercise the picture slot rather than the placeholder-free layout.
    const flags = { ...defaultFlags, eventImagesEnabled: true, eventScheduleEnabled: scheduleEnabled, ...extraFlags };
    return renderWithProviders(
        <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
            <MyRatingsProvider>
                <MyEventsList events={events} tab={tab} onEventClick={onEventClick} />
            </MyRatingsProvider>
        </FeatureFlagsContext.Provider>,
        { routerEntries: ['/mine/calendar'] },
    );
}

function SavedProbe({ eventId }: { eventId: string }) {
    const { isSaved } = useSavedEvents();
    return <span data-testid="saved-probe">{isSaved(eventId) ? 'saved' : 'unsaved'}</span>;
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
    it('groups rows by month without map sequence numbers and shows the base Upcoming card', () => {
        renderList('upcoming', [event('one', '/event.jpg'), event('two', null)]);

        expect(screen.getByText('September 2026')).toBeInTheDocument();
        expect(screen.getAllByTestId('my-events-row')).toHaveLength(2);
        expect(screen.getAllByTestId('event-card-image')).toHaveLength(1);
        expect(screen.queryByText('#1')).not.toBeInTheDocument();
        // Upcoming keeps the base card (picture, title, time, location) plus
        // the avatars stack — no Save / I'm going action buttons.
        expect(screen.queryByRole('button', { name: 'Save event' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: "I'm going" })).not.toBeInTheDocument();
    });

    it('shows My Plan only on an Upcoming card when the shared count is positive', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/users/me/ratings', () => HttpResponse.json([])),
            http.post('*/api/my-plan/counts', () => HttpResponse.json([
                { event_id: 'planned', plan_count: 3 },
            ])),
        );
        const plannedEvent = { ...event('planned', null), schedule_published: true };
        const { unmount } = renderList('upcoming', [plannedEvent], vi.fn(), true);

        expect(await screen.findByRole('link', { name: 'My Plan' })).toHaveAttribute('href', '/event/planned/program/plan');
        unmount();

        renderList('saved', [plannedEvent], vi.fn(), true);
        expect(screen.queryByRole('link', { name: 'My Plan' })).not.toBeInTheDocument();
    });

    it('removes a failed image and swaps Save for a discreet remove button on Saved', () => {
        renderList('saved', [event('saved', '/broken.jpg')]);

        fireEvent.error(screen.getByTestId('event-card-image'));
        expect(screen.queryByTestId('event-card-image')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save event' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Remove from saved' })).toBeInTheDocument();
        const going = screen.getByRole('button', { name: "I'm going" });
        expect(going.querySelector('[data-icon-family="hand"]')).toBeInTheDocument();
    });

    it('unsaves from the Saved card and restores it with Undo', async () => {
        const writes: string[] = [];
        server.use(
            http.get('*/api/auth/saved-events', () => HttpResponse.json({ events: [{ event_id: 'saved', audience: 'private' }] })),
            http.post('*/api/track/event-save', async ({ request }) => {
                const body = await request.json() as { action: string };
                writes.push(body.action);
                return new HttpResponse(null, { status: 204 });
            }),
        );
        const flags = { ...defaultFlags, eventImagesEnabled: true };
        const { user } = renderWithProviders(
            <ToastProvider>
                <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
                    <MyRatingsProvider>
                        <SavedProbe eventId="saved" />
                        <MyEventsList events={[event('saved', null)]} tab="saved" onEventClick={vi.fn()} />
                    </MyRatingsProvider>
                </FeatureFlagsContext.Provider>
            </ToastProvider>,
            { routerEntries: ['/mine/calendar'] },
        );

        await waitFor(() => expect(screen.getByTestId('saved-probe')).toHaveTextContent(/^saved$/));
        await user.click(screen.getByRole('button', { name: 'Remove from saved' }));
        expect(await screen.findByText('Removed from saved')).toBeInTheDocument();
        expect(screen.getByTestId('saved-probe')).toHaveTextContent('unsaved');
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(writes).toEqual(['unsave', 'save']));
        expect(screen.getByTestId('saved-probe')).toHaveTextContent(/^saved$/);
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
        expect(screen.getByTestId('event-card-image')).toHaveClass('grayscale');
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

    it('shows a memories strip on Past cards only when there are photos or uploads are open', async () => {
        const thumb = (id: string) => ({ id, thumb_url: `https://signed.test/${id}`, visibility: 'private' as const });
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/users/me/ratings', () => HttpResponse.json([])),
            http.get('*/api/tags', () => HttpResponse.json([])),
            http.post('*/api/me/event-assets/summary', () => HttpResponse.json({
                full: { ticket_count: 0, memory_count: 4, memory_thumbs: [thumb('a'), thumb('b'), thumb('c')], can_add_memory: false, memory_window_closes_at: '2026-10-05T20:00:00Z' },
                open: { ticket_count: 0, memory_count: 0, memory_thumbs: [], can_add_memory: true, memory_window_closes_at: '2026-10-05T20:00:00Z' },
                closed: { ticket_count: 0, memory_count: 0, memory_thumbs: [], can_add_memory: false, memory_window_closes_at: '2026-10-05T20:00:00Z' },
            })),
        );

        renderList('past', [event('full', null), event('open', null), event('closed', null)], vi.fn(), false, { eventMemoriesEnabled: true });

        const strips = await screen.findAllByTestId('memories-strip');
        expect(strips).toHaveLength(2);
        expect(screen.getByRole('link', { name: '4 memories' })).toHaveAttribute('href', '/event/full#memories');
        expect(screen.getByText('+1')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Add memories · until/ })).toHaveAttribute('href', '/event/open#memories');
    });

    it('shows only My ticket (never Add ticket) on Upcoming cards from the batched summary', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.post('*/api/me/event-assets/summary', () => HttpResponse.json({
                one: { ticket_count: 1, memory_count: 0, memory_thumbs: [], can_add_memory: false, memory_window_closes_at: null },
                two: { ticket_count: 0, memory_count: 0, memory_thumbs: [], can_add_memory: false, memory_window_closes_at: null },
                intl: { ticket_count: 0, memory_count: 0, memory_thumbs: [], can_add_memory: false, memory_window_closes_at: null },
            })),
            http.get('*/api/events/one/assets', () => new HttpResponse(null, { status: 404 })),
        );
        const future = (id: string, likely = false): CalendarEvent => ({
            ...event(id, null),
            start: '2099-09-05T20:00:00Z',
            end: '2099-09-05T22:00:00Z',
            ticket_likely: likely,
        });

        const { user } = renderList('upcoming', [future('one'), future('two'), future('intl', true)], vi.fn(), false, { eventTicketsEnabled: true });

        expect(await screen.findByRole('button', { name: 'My ticket' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Add ticket/ })).not.toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /ticket/i })).toHaveLength(1);

        await user.click(screen.getByRole('button', { name: 'My ticket' }));
        expect(await screen.findByRole('dialog', { name: /My ticket/ })).toBeInTheDocument();
    });

    it('does not render stray text in the list', () => {
        const { container } = renderList('upcoming', [event('one', null)]);
        expect(container.textContent).not.toContain('assetSummaries');
    });
});
