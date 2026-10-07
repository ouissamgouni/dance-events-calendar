import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../types'
import * as api from '../api'
import AdminEventDetailContent from './AdminEventDetailContent'


vi.mock('../api', () => ({
    fetchAdminCalendars: vi.fn().mockResolvedValue([]),
    retryGeocodingSingle: vi.fn(),
}))
vi.mock('./AddressAutocomplete', () => ({ default: () => <div /> }))
vi.mock('./AdminAutoTagSuggestions', () => ({ default: () => <div /> }))
vi.mock('./AdminEventPromoCodes', () => ({ default: () => <div /> }))
vi.mock('./InlineTagsPicker', () => ({ default: () => <div /> }))
vi.mock('./LocationBadge', () => ({ default: () => <div /> }))
vi.mock('./TagBadges', () => ({ default: () => <div /> }))


function event(): CalendarEvent {
    return {
        event_id: 'evt-1',
        calendar_id: 'cal-1',
        title: 'Salsa Night',
        description: 'Displayed description',
        source_description: 'Displayed description\n<<<EXTRACTOR_JSON>>>\n{"tags":["salsa"]}\n<<<END_EXTRACTOR_JSON>>>',
        location: null,
        latitude: null,
        longitude: null,
        start: '2026-10-01T20:00:00Z',
        end: '2026-10-01T23:00:00Z',
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: null,
        links: [],
        tags: [],
    }
}


beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.fetchAdminCalendars).mockResolvedValue([])
})


describe('AdminEventDetailContent calendar source', () => {
    it('keeps the raw source collapsed until requested', async () => {
        render(<AdminEventDetailContent event={event()} onFieldSave={vi.fn()} />)

        const disclosure = screen.getByText('Calendar source').closest('details')
        expect(disclosure).not.toHaveAttribute('open')

        await userEvent.click(screen.getByText('Calendar source'))

        expect(disclosure).toHaveAttribute('open')
        expect(screen.getByText(/<<<EXTRACTOR_JSON>>>/)).toBeVisible()
        expect(screen.getByText('Displayed description', { selector: 'p' })).toBeVisible()
    })
})


describe('AdminEventDetailContent when section', () => {
    it('saves an unchanged datetime without shifting it', async () => {
        const onFieldSave = vi.fn().mockResolvedValue(undefined)
        render(<AdminEventDetailContent event={event()} onFieldSave={onFieldSave} />)

        await userEvent.click(screen.getByRole('button', { name: 'Edit date and time' }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onFieldSave).toHaveBeenCalledWith({
            start: '2026-10-01T20:00:00.000Z',
            end: '2026-10-01T23:00:00.000Z',
            all_day: false,
        })
    })

    it('shows the end date of a multi-day event', () => {
        const multiDay = { ...event(), start: '2026-10-01T12:00:00Z', end: '2026-10-03T12:00:00Z' }
        render(<AdminEventDetailContent event={multiDay} onFieldSave={vi.fn()} />)

        const end = new Date(multiDay.end).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
        expect(screen.getByText(new RegExp(end))).toBeInTheDocument()
    })
})


describe('AdminEventDetailContent ticket eligible', () => {
    it('shows the effective value and pins a choice', async () => {
        const onFieldSave = vi.fn().mockResolvedValue(undefined)
        const intl = { ...event(), ticket_likely: true, ticket_likely_reason: 'international' as const }
        render(<AdminEventDetailContent event={intl} onFieldSave={onFieldSave} />)

        expect(screen.getByText('Ticket eligible')).toBeInTheDocument()
        expect(screen.getByText('international')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: 'No' }))
        expect(onFieldSave).toHaveBeenCalledWith({ advance_ticket_override: false })
    })

    it('resets an admin pin back to auto', async () => {
        const onFieldSave = vi.fn().mockResolvedValue(undefined)
        const pinned = { ...event(), advance_ticket_override: true, ticket_likely: true, ticket_likely_reason: 'admin' as const }
        render(<AdminEventDetailContent event={pinned} onFieldSave={onFieldSave} />)

        await userEvent.click(screen.getAllByRole('button', { name: 'Auto' }).at(-1)!)
        expect(onFieldSave).toHaveBeenCalledWith({ advance_ticket_override: null })
    })
})
