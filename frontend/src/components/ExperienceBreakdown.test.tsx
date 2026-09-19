import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import ExperienceBreakdown from './ExperienceBreakdown'
import type { EventRatingAggregate } from '../types'

function makeAggregate(overrides: Partial<EventRatingAggregate> = {}): EventRatingAggregate {
    return {
        event_id: 'evt-1',
        count: 2,
        sentiment_distribution: { amazing: 1, great: 1, okay: 0, disappointing: 0, bad: 0 },
        aspects: [
            { aspect_slug: 'music', average: 4.5, count: 2 },
            { aspect_slug: 'crowd', average: 4, count: 1 },
        ],
        top_positive_tags: [{ tag_id: 1, slug: 'great-music', label: 'Great music', count: 2, aspect_slug: 'music' }],
        top_neutral_tags: [{ tag_id: 4, slug: 'large', label: 'Large (500-2,000)', count: 2, aspect_slug: 'event-size' }],
        top_negative_tags: [{ tag_id: 2, slug: 'too-crowded', label: 'Too crowded', count: 1, aspect_slug: 'crowd' }],
        top_audience_tags: [{ tag_id: 3, slug: 'beginners', label: 'Beginners', count: 1, aspect_slug: null }],
        average_mood: 4.5,
        positive_percentage: 100,
        neutral_percentage: 0,
        negative_percentage: 0,
        mood_label: 'Exceptional',
        display_state: 'full',
        ...overrides,
    }
}

describe('ExperienceBreakdown', () => {
    it('renders the mood headline, community summary, and per-aspect stars', () => {
        render(<ExperienceBreakdown aggregate={makeAggregate()} aspectLabels={{ music: 'Music' }} />)

        expect(screen.getByText(/Exceptional/)).toBeInTheDocument()
        expect(screen.getByText(/rated it Great or Amazing/)).toBeInTheDocument()
        expect(screen.getByText(/Based on 2 reviews/)).toBeInTheDocument()
        expect(screen.getByText(/Music/)).toBeInTheDocument()
        expect(screen.getByText(/Music/)).toHaveTextContent('Amazing')
        expect(screen.getByText('People appreciated')).toBeInTheDocument()
        expect(screen.getByText('Great music (2)')).toBeInTheDocument()
        expect(screen.getByText('People mentioned')).toBeInTheDocument()
        expect(screen.getByText('Large (500-2,000) (2)')).toHaveClass('bg-slate-100')
        expect(screen.getByText('Too crowded (1)')).toHaveClass('bg-orange-50')
        expect(screen.queryByText('Good to know')).not.toBeInTheDocument()
        expect(screen.getByText('Best suited for')).toBeInTheDocument()
        expect(screen.getByText('Beginners (1)')).toBeInTheDocument()
    })

    it('shows edition count in the headline when provided (series roll-up)', () => {
        render(<ExperienceBreakdown aggregate={makeAggregate({ count: 146 })} editionCount={10} />)
        expect(screen.getByText(/Based on 10 editions · 146 reviews/)).toBeInTheDocument()
    })

    it('shows an "Early feedback" headline without a mood label below threshold', () => {
        render(
            <ExperienceBreakdown
                aggregate={makeAggregate({ display_state: 'early', mood_label: null, count: 1 })}
            />,
        )
        expect(screen.getByText('Early feedback')).toBeInTheDocument()
        expect(screen.queryByText('Exceptional')).not.toBeInTheDocument()
    })

    it('renders nothing when the aggregate has no structured data', () => {
        const { container } = render(
            <ExperienceBreakdown
                aggregate={makeAggregate({
                    sentiment_distribution: {},
                    aspects: [],
                    top_positive_tags: [],
                    top_neutral_tags: [],
                    top_negative_tags: [],
                    top_audience_tags: [],
                    display_state: 'none',
                })}
            />,
        )

        expect(container).toBeEmptyDOMElement()
    })
})
