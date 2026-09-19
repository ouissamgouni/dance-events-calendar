import { describe, expect, it, vi } from 'vitest'
import { within } from '@testing-library/react'
import EventSummary from './EventSummary'
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext'
import { renderWithProviders } from '../test/render'
import { fetchEventMessages } from '../api'
import type { CalendarEvent, Tag } from '../types'

// EventSummary loads a message count on mount and the feature flags provider
// fetches site settings — stub both so the parity test is hermetic. Everything
// else keeps the real implementation so the shared markup is exercised as-is.
vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>()
    return {
        ...actual,
        fetchEventMessages: vi.fn(async () => ({ items: [], total: 0 })),
        fetchSettings: vi.fn(async () => {
            throw new Error('settings disabled in test')
        }),
    }
})

vi.mock('../hooks/useCommunityExperience', () => ({
    useCommunityExperience: () => ({
        aggregate: null,
        crossEdition: false,
        series: {
            series_id: 42,
            canonical_title: 'Berlin Weekly Salsa',
            edition_count: 4,
            reviewed_edition_count: 0,
            total_review_count: 0,
            average_mood: 0,
            positive_percentage: 0,
            mood_label: null,
            display_state: 'none',
            sentiment_distribution: {},
            aspects: [],
            top_positive_tags: [],
            top_neutral_tags: [],
            top_negative_tags: [],
            top_audience_tags: [],
            editions: [],
        },
    }),
}))

const TAGS: Tag[] = [
    {
        id: 1,
        slug: 'salsa',
        label: 'Salsa',
        color: '#111',
        ordinal: 0,
        group_slug: 'dance-style',
        group_label: 'Dance style',
        group_color: null,
        enabled: true,
        is_hero_filter: false,
        hero_ordinal: null,
    },
    {
        id: 2,
        slug: 'bachata',
        label: 'Bachata',
        color: '#222',
        ordinal: 1,
        group_slug: 'dance-style',
        group_label: 'Dance style',
        group_color: null,
        enabled: true,
        is_hero_filter: false,
        hero_ordinal: null,
    },
]

const FULL_LOCATION = 'Havana Club, 12 Main Street'

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    // A future, single-day event with no coordinates (keeps Leaflet out of jsdom).
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000)
    return {
        event_id: 'evt-1',
        calendar_id: 'cal-1',
        title: 'Berlin Salsa Social',
        description: 'A friendly weekly social with a beginner lesson before the party.',
        image_url: null,
        location: FULL_LOCATION,
        city: 'Berlin',
        country: 'Germany',
        latitude: null,
        longitude: null,
        start: start.toISOString(),
        end: end.toISOString(),
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: true,
        links: null,
        tags: TAGS,
        ...overrides,
    }
}

/** The content EventSummary must render identically on both surfaces. */
function sharedLandmarks(container: HTMLElement) {
    const w = within(container)
    return {
        title: w.getByRole('heading', { level: 2 }).textContent,
        tags: TAGS.map((t) => !!w.queryByText(t.label)),
        aboutMore: !!w.queryByText('…more'),
    }
}

function renderSummary(
    variant: 'page' | 'modal',
    showActions = true,
    event = makeEvent(),
    onOpenTab = vi.fn(),
    onSeriesNavigate = vi.fn(),
) {
    return renderWithProviders(
        <FeatureFlagsProvider>
            <EventSummary
                event={event}
                variant={variant}
                shareUrl="https://example.test/e/evt-1"
                onOpenTab={onOpenTab}
                onPostMessage={vi.fn()}
                onSeriesNavigate={onSeriesNavigate}
                showActions={showActions}
            />
        </FeatureFlagsProvider>,
    )
}

describe('EventSummary shared implementation', () => {
    it('renders identical landmark content on the page and in the modal', () => {
        const page = renderSummary('page').container
        const modal = renderSummary('modal').container

        // The page and modal render the very same component — the summary must
        // never fork its markup per surface. Every shared landmark matches.
        expect(sharedLandmarks(page)).toEqual(sharedLandmarks(modal))
    })

    it('applies the only sanctioned per-variant branch (location)', () => {
        const page = renderSummary('page').container
        const modal = renderSummary('modal').container

        // Page shows the full location string; the modal collapses it to
        // "city, country" — the single documented variant difference.
        expect(within(page).getByText(FULL_LOCATION)).toBeInTheDocument()
        expect(within(modal).getByText('Berlin, Germany')).toBeInTheDocument()
        expect(within(modal).queryByText(FULL_LOCATION)).toBeNull()
    })

    it('hides the inline action row on the page (the dock owns it) but keeps it in the modal', () => {
        // On the full page the persistent EventActionDock renders the primary
        // actions, so the summary suppresses its inline row via showActions=false.
        const page = renderSummary('page', false).container
        expect(within(page).queryByRole('button', { name: 'Save event' })).toBeNull()
        expect(within(page).queryByRole('button', { name: 'More actions' })).toBeNull()

        // The modal has no dock, so it keeps the inline actions.
        const modal = renderSummary('modal').container
        expect(within(modal).getByRole('button', { name: 'Save event' })).toBeInTheDocument()
        expect(within(modal).getByRole('button', { name: 'More actions' })).toBeInTheDocument()
    })

    it('opens Details from About and only shows …more when the preview overflows', async () => {
        const onOpenTab = vi.fn()
        const short = renderSummary('page', false, makeEvent(), onOpenTab)

        expect(within(short.container).queryByText('…more')).toBeNull()
        await short.user.click(within(short.container).getByRole('button', { name: /friendly weekly social/i }))
        expect(onOpenTab).toHaveBeenCalledWith('about')

        short.unmount()
        const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80)
        const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40)
        try {
            const long = renderSummary('page', false)
            expect(within(long.container).getByText('…more')).toBeInTheDocument()
        } finally {
            scrollHeight.mockRestore()
            clientHeight.mockRestore()
        }
    })

    it('routes People and Posts independently', async () => {
        vi.mocked(fetchEventMessages).mockResolvedValueOnce({ items: [], total: 2 })
        const onOpenTab = vi.fn()
        const view = renderSummary('page', false, makeEvent({ going_count: 3 }), onOpenTab)

        await view.user.click(within(view.container).getByRole('button', { name: /people going/i }))
        expect(onOpenTab).toHaveBeenCalledWith('people')

        await view.user.click(await within(view.container).findByRole('button', { name: '2 Posts' }))
        expect(onOpenTab).toHaveBeenCalledWith('discussion')
    })

    it('omits the Links heading and opens the series route directly', async () => {
        const onSeriesNavigate = vi.fn()
        const view = renderSummary(
            'page',
            false,
            makeEvent({ links: [{ url: 'https://example.test/tickets', label: 'Tickets' }] }),
            vi.fn(),
            onSeriesNavigate,
        )

        expect(within(view.container).queryByText('Links')).toBeNull()
        expect(within(view.container).getByRole('link', { name: 'Tickets' })).toBeInTheDocument()
        const seriesLink = within(view.container).getByRole('link', { name: 'Open series Berlin Weekly Salsa' })
        expect(seriesLink).toHaveAttribute('href', '/series/42')
        await view.user.click(seriesLink)
        expect(onSeriesNavigate).toHaveBeenCalledOnce()
    })
})
