import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ShareExperienceCard from './ShareExperienceCard'
import type { PendingReview } from '../types'

vi.mock('../context/MyRatingsContext', () => ({
    useUpsertMyRating: () => vi.fn(),
}))
vi.mock('../context/RatingAggregatesContext', () => ({
    useInvalidateRatingAggregate: () => vi.fn(),
}))
vi.mock('../utils/tracking', () => ({
    trackRatingModalOpened: vi.fn(),
}))
// Stub the heavy modal with a tiny fake that lets the test drive onSubmitted.
vi.mock('./RateEventModal', () => ({
    default: ({ onSubmitted }: { onSubmitted: (r: unknown) => void }) => (
        <button type="button" onClick={() => onSubmitted({ id: 'r1' })}>
            fake-submit
        </button>
    ),
}))

function makeReview(overrides: Partial<PendingReview> = {}): PendingReview {
    return {
        event_id: 'ev-1',
        event_title: 'Barcelona Thursday Social',
        event_start: new Date(Date.now() - 86_400_000).toISOString(),
        event_end: new Date(Date.now() - 72_000_000).toISOString(),
        friend_proof: null,
        ...overrides,
    }
}

describe('ShareExperienceCard', () => {
    it('renders the attended line and a Review button, no proof line when absent', () => {
        render(<ShareExperienceCard review={makeReview()} onReviewed={vi.fn()} />)
        expect(screen.getByText(/You attended/)).toHaveTextContent(
            'You attended Barcelona Thursday Social yesterday.',
        )
        expect(screen.queryByText(/Reviewed by/)).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument()
    })

    it('shows the friend proof line when present', () => {
        render(
            <ShareExperienceCard review={makeReview({ friend_proof: 'Laura' })} onReviewed={vi.fn()} />,
        )
        expect(screen.getByText('Reviewed by Laura')).toBeInTheDocument()
    })

    it('opens the modal and calls onReviewed after submitting', () => {
        const onReviewed = vi.fn()
        render(<ShareExperienceCard review={makeReview()} onReviewed={onReviewed} />)
        fireEvent.click(screen.getByRole('button', { name: 'Review' }))
        fireEvent.click(screen.getByRole('button', { name: 'fake-submit' }))
        expect(onReviewed).toHaveBeenCalledWith('ev-1')
    })
})
