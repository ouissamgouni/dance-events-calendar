import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MatchesCell } from './EventsPanel'

const reach = {
    eligible: true,
    ineligible_reason: null,
    matched_profiles: 5,
    matched_users: 4,
    already_notified_users: 1,
    would_alert_app: 3,
    would_alert_email: 2,
    would_alert_push: 1,
}

describe('MatchesCell', () => {
    it('shows notified/matching users with a tooltip explaining the rest', () => {
        const { container } = render(<MatchesCell reach={reach} />)
        const cell = container.firstElementChild as HTMLElement
        expect(cell).toHaveTextContent('1/4')
        expect(cell.title).toBe(
            '1 of 4 matching users notified (5 saved searches) · 3 not notified yet, alerted on next event update',
        )
    })

    it('shows a dash with the reason when the event cannot trigger alerts', () => {
        render(<MatchesCell reach={{ ...reach, eligible: false, ineligible_reason: 'pending review' }} />)
        expect(screen.getByText('—')).toHaveAttribute(
            'title',
            'No saved-search alerts: pending review · 1 notified earlier',
        )
    })
})
