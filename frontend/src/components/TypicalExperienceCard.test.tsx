import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import TypicalExperienceCard from './TypicalExperienceCard'
import type { SeriesRatingRollup } from '../types'

function makeSeries(overrides: Partial<SeriesRatingRollup> = {}): SeriesRatingRollup {
    return {
        series_id: 7,
        canonical_title: 'Tuesday Salsa Night',
        edition_count: 10,
        reviewed_edition_count: 10,
        total_review_count: 146,
        average_mood: 3.6,
        positive_percentage: 75,
        mood_label: 'Well received',
        display_state: 'full',
        sentiment_distribution: {},
        aspects: [],
        top_positive_tags: [],
        top_neutral_tags: [],
        top_negative_tags: [],
        top_audience_tags: [],
        editions: [],
        ...overrides,
    }
}

const renderCard = (series: SeriesRatingRollup) =>
    render(
        <MemoryRouter>
            <TypicalExperienceCard series={series} />
        </MemoryRouter>,
    )

describe('TypicalExperienceCard', () => {
    it('renders the "Usually {mood}" headline, positive %, edition count, and series link', () => {
        renderCard(makeSeries())
        expect(screen.getByText('Typical experience')).toBeInTheDocument()
        expect(screen.getByText(/Usually well received/)).toBeInTheDocument()
        expect(screen.getByText('75%')).toBeInTheDocument()
        expect(screen.getByText(/Based on the last 10 editions/)).toBeInTheDocument()
        const link = screen.getByRole('link', { name: /See other editions/ })
        expect(link).toHaveAttribute('href', '/series/7')
    })

    it('shows "Early feedback" instead of a mood label below threshold', () => {
        renderCard(makeSeries({ display_state: 'early', mood_label: null }))
        expect(screen.getByText('Early feedback')).toBeInTheDocument()
        expect(screen.queryByText(/Usually/)).not.toBeInTheDocument()
    })

    it('renders nothing for a single-edition series', () => {
        const { container } = renderCard(makeSeries({ edition_count: 1 }))
        expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing when the series has no feedback yet', () => {
        const { container } = renderCard(makeSeries({ display_state: 'none' }))
        expect(container).toBeEmptyDOMElement()
    })
})
