import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import EventCard from './EventCard'
import {
    FeatureFlagsContext,
    defaultFlags,
    type FeatureFlags,
} from '../context/FeatureFlagsContext'
import { renderWithProviders } from '../test/render'
import type { CalendarEvent } from '../types'

vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>()
    return {
        ...actual,
        fetchSettings: vi.fn(async () => {
            throw new Error('settings disabled in test')
        }),
    }
})

function withFlags(overrides: Partial<FeatureFlags>) {
    const flags = { ...defaultFlags, ...overrides }
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
                {children}
            </FeatureFlagsContext.Provider>
        )
    }
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    return {
        event_id: 'evt-1',
        calendar_id: 'cal-1',
        title: 'Berlin Salsa Social',
        description: null,
        location: 'Havana Club',
        latitude: null,
        longitude: null,
        start: start.toISOString(),
        end: new Date(start.getTime() + 3 * 60 * 60 * 1000).toISOString(),
        all_day: false,
        color: '#111',
        ...overrides,
    } as CalendarEvent
}

function renderCard(
    event: CalendarEvent,
    flags: Partial<FeatureFlags>,
    props: { isPast?: boolean } = {},
) {
    const Wrapper = withFlags(flags)
    return renderWithProviders(
        <Wrapper>
            <EventCard event={event} onOpen={vi.fn()} {...props} />
        </Wrapper>,
    )
}

describe('EventCard pictures', () => {
    it('hides pictures and placeholders when the flag is off', () => {
        renderCard(
            makeEvent({ image_thumb_url: 'https://cdn.test/thumb.webp' }),
            { eventImagesEnabled: false },
        )

        expect(screen.queryByTestId('event-card-image')).not.toBeInTheDocument()
        expect(screen.queryByTestId('event-card-placeholder')).not.toBeInTheDocument()
    })

    it('prefers the cropped thumb variant over the plain url', () => {
        renderCard(
            makeEvent({
                image_url: 'https://cdn.test/full.webp',
                image_thumb_url: 'https://cdn.test/thumb.webp',
            }),
            { eventImagesEnabled: true },
        )

        expect(screen.getByTestId('event-card-image')).toHaveAttribute(
            'src',
            'https://cdn.test/thumb.webp',
        )
    })

    it('falls back to the plain url when there is no cropped variant', () => {
        renderCard(makeEvent({ image_url: 'https://origin.example/legacy.jpg' }), {
            eventImagesEnabled: true,
        })

        expect(screen.getByTestId('event-card-image')).toHaveAttribute(
            'src',
            'https://origin.example/legacy.jpg',
        )
    })

    it('renders a placeholder when the event has no picture', () => {
        renderCard(makeEvent(), { eventImagesEnabled: true })

        expect(screen.queryByTestId('event-card-image')).not.toBeInTheDocument()
        expect(screen.getByTestId('event-card-placeholder')).toHaveAttribute(
            'data-placeholder-style',
            'gradient',
        )
    })

    it('honours the initial placeholder style', () => {
        renderCard(makeEvent(), {
            eventImagesEnabled: true,
            eventCardPlaceholderStyle: 'initial',
        })

        expect(screen.getByTestId('event-card-placeholder')).toHaveTextContent('B')
    })

    it('shows neither picture nor placeholder for past events', () => {
        renderCard(
            makeEvent({ image_thumb_url: 'https://cdn.test/thumb.webp' }),
            { eventImagesEnabled: true },
            { isPast: true },
        )

        expect(screen.queryByTestId('event-card-image')).not.toBeInTheDocument()
        expect(screen.queryByTestId('event-card-placeholder')).not.toBeInTheDocument()
    })
})
