import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import SeriesPage from './SeriesPage'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'
import type { SeriesRatingRollup } from '../types'

const rollup: SeriesRatingRollup = {
    series_id: 5,
    canonical_title: 'Weekly Milonga',
    edition_count: 2,
    reviewed_edition_count: 2,
    total_review_count: 3,
    average_mood: 4.5,
    positive_percentage: 100,
    mood_label: 'Exceptional',
    display_state: 'full',
    sentiment_distribution: { amazing: 2, great: 1, okay: 0, disappointing: 0, bad: 0 },
    aspects: [{ aspect_slug: 'music', average: 4.5, count: 3 }],
    top_positive_tags: [{ tag_id: 1, slug: 'great-dj', label: 'Great DJ', count: 2, aspect_slug: 'music' }],
    top_neutral_tags: [],
    top_negative_tags: [],
    top_audience_tags: [],
    editions: [
        {
            event_id: 'evt-series-2',
            title: 'Weekly Milonga',
            start: '2099-01-08T20:00:00Z',
            end: '2099-01-09T01:00:00Z',
            review_count: 2,
            average_mood: 5,
            positive_percentage: 100,
            mood_label: 'Exceptional',
            display_state: 'full',
        },
        {
            event_id: 'evt-series-1',
            title: 'Weekly Milonga',
            start: '2099-01-01T20:00:00Z',
            end: '2099-01-02T01:00:00Z',
            review_count: 1,
            average_mood: 4,
            positive_percentage: 100,
            mood_label: null,
            display_state: 'early',
        },
    ],
}

describe('SeriesPage', () => {
    it('renders the pooled roll-up headline and per-edition list', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/series/5', () => HttpResponse.json(rollup)),
            http.get('*/api/tags', () => HttpResponse.json([])),
        )

        renderWithProviders(
            <HelmetProvider>
                <Routes>
                    <Route path="/series/:seriesId" element={<SeriesPage />} />
                </Routes>
            </HelmetProvider>,
            { routerEntries: ['/series/5'] },
        )

        expect(await screen.findByRole('heading', { name: 'Weekly Milonga' })).toBeInTheDocument()
        expect(screen.getAllByText(/Exceptional/).length).toBeGreaterThan(0)
        expect(screen.getByText(/Recurring series ·/)).toBeInTheDocument()
        expect(screen.getByText(/Based on 2 editions · 3 reviews/)).toBeInTheDocument()
        expect(screen.getByText('Editions')).toBeInTheDocument()
        // Both editions link back to their event pages.
        const links = screen.getAllByRole('link')
        const hrefs = links.map((l) => l.getAttribute('href'))
        expect(hrefs).toContain('/event/evt-series-2')
        expect(hrefs).toContain('/event/evt-series-1')
    })

    it('shows a not-found message when the series is missing', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/series/9', () => new HttpResponse(null, { status: 404 })),
            http.get('*/api/tags', () => HttpResponse.json([])),
        )

        renderWithProviders(
            <HelmetProvider>
                <Routes>
                    <Route path="/series/:seriesId" element={<SeriesPage />} />
                </Routes>
            </HelmetProvider>,
            { routerEntries: ['/series/9'] },
        )

        expect(await screen.findByText(/could not be found/)).toBeInTheDocument()
    })
})
