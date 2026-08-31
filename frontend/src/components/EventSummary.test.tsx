import { describe, expect, it, vi } from 'vitest'
import { within } from '@testing-library/react'
import EventSummary from './EventSummary'
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext'
import { renderWithProviders } from '../test/render'
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

function makeEvent(): CalendarEvent {
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
    }
}

/** The content EventSummary must render identically on both surfaces. */
function sharedLandmarks(container: HTMLElement) {
    const w = within(container)
    return {
        title: w.getByRole('heading', { level: 2 }).textContent,
        tags: TAGS.map((t) => !!w.queryByText(t.label)),
        aboutMore: !!w.queryByRole('button', { name: '…more' }),
    }
}

function renderSummary(variant: 'page' | 'modal', showActions = true) {
    const { container } = renderWithProviders(
        <FeatureFlagsProvider>
            <EventSummary
                event={makeEvent()}
                variant={variant}
                shareUrl="https://example.test/e/evt-1"
                onOpenTab={vi.fn()}
                onPostMessage={vi.fn()}
                showActions={showActions}
            />
        </FeatureFlagsProvider>,
    )
    return container
}

describe('EventSummary shared implementation', () => {
    it('renders identical landmark content on the page and in the modal', () => {
        const page = renderSummary('page')
        const modal = renderSummary('modal')

        // The page and modal render the very same component — the summary must
        // never fork its markup per surface. Every shared landmark matches.
        expect(sharedLandmarks(page)).toEqual(sharedLandmarks(modal))
    })

    it('applies the only sanctioned per-variant branch (location)', () => {
        const page = renderSummary('page')
        const modal = renderSummary('modal')

        // Page shows the full location string; the modal collapses it to
        // "city, country" — the single documented variant difference.
        expect(within(page).getByText(FULL_LOCATION)).toBeInTheDocument()
        expect(within(modal).getByText('Berlin, Germany')).toBeInTheDocument()
        expect(within(modal).queryByText(FULL_LOCATION)).toBeNull()
    })

    it('hides the inline action row on the page (the dock owns it) but keeps it in the modal', () => {
        // On the full page the persistent EventActionDock renders the primary
        // actions, so the summary suppresses its inline row via showActions=false.
        const page = renderSummary('page', false)
        expect(within(page).queryByRole('button', { name: 'Save event' })).toBeNull()
        expect(within(page).queryByRole('button', { name: 'More actions' })).toBeNull()

        // The modal has no dock, so it keeps the inline actions.
        const modal = renderSummary('modal')
        expect(within(modal).getByRole('button', { name: 'Save event' })).toBeInTheDocument()
        expect(within(modal).getByRole('button', { name: 'More actions' })).toBeInTheDocument()
    })
})
