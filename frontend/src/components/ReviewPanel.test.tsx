import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import ReviewPanel from './ReviewPanel'
import * as api from '../api'
import type { AdminChange } from '../api'

vi.mock('../api', () => ({
    decideAdminChange: vi.fn(),
    fetchAdminCalendars: vi.fn(() => Promise.resolve([{ calendar_id: 'cal-public', name: 'Public calendar' }])),
    fetchAdminChanges: vi.fn(),
}))

vi.mock('../hooks/useAdminCounters', () => ({
    notifyAdminDataChanged: vi.fn(),
}))

vi.mock('./AdminEventDetailPanel', () => ({ default: () => null }))

function change(overrides: Partial<AdminChange>): AdminChange {
    return {
        id: 1,
        event_id: 'evt-1',
        suggestion_id: null,
        kind: 'create',
        source: 'sync',
        status: 'pending',
        changes: {},
        material_fields: [],
        proposed_by: null,
        proposed_by_admin_email: null,
        decided_by: null,
        decided_at: null,
        notified_count: 0,
        affected_attendees: 0,
        series_dates: 1,
        series_affected_attendees: 0,
        group_size: 1,
        created_at: '2026-10-01T10:00:00Z',
        updated_at: '2026-10-01T10:00:00Z',
        submitter_name: null,
        event: {
            event_id: 'evt-1',
            title: 'Friday Salsa',
            start: '2026-10-16T20:00:00Z',
            end: '2026-10-16T23:00:00Z',
            all_day: false,
            timezone: 'UTC',
            location: 'Studio',
            status: 'new',
            visibility_state: 'public',
            occurrences: 1,
            is_submission: false,
        },
        ...overrides,
    }
}

describe('ReviewPanel', () => {
    beforeEach(() => {
        vi.mocked(api.fetchAdminChanges).mockResolvedValue({
            items: [
                change({}),
                change({
                    id: 2,
                    kind: 'go_public',
                    source: 'submitter',
                    event_id: null,
                    suggestion_id: 'sug-1',
                    submitter_name: 'Olivia',
                    event: { ...change({}).event!, event_id: 'evt-2', title: 'Olivia Bachata', status: 'published', visibility_state: 'private', occurrences: 3 },
                }),
            ],
            total: 2,
            kinds: [
                { value: 'create', label: 'New event', count: 1 },
                { value: 'go_public', label: 'Go public', count: 1 },
            ],
            sources: [{ value: 'sync', label: 'Google Calendar', count: 1 }],
        })
        vi.mocked(api.decideAdminChange).mockResolvedValue(change({ status: 'accepted' }))
    })

    it('lists every kind of change with its counts', async () => {
        render(<MemoryRouter><ReviewPanel isOpen onClose={() => { }} /></MemoryRouter>)

        expect(await screen.findByText('Friday Salsa')).toBeInTheDocument()
        expect(screen.getByText('Olivia Bachata')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'New event (1)' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Go public (1)' })).toBeInTheDocument()
        expect(screen.getByText('×3')).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: 'Open' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: 'Closed' })).toBeInTheDocument()
    })

    it('publishes a new event and makes a submission public in the chosen calendar', async () => {
        const user = userEvent.setup()
        render(<MemoryRouter><ReviewPanel isOpen onClose={() => { }} /></MemoryRouter>)

        await user.click(await screen.findByText('Friday Salsa'))
        await user.click(screen.getByRole('button', { name: 'Publish' }))
        await waitFor(() => expect(api.decideAdminChange).toHaveBeenCalledWith(1, expect.objectContaining({ decision: 'accept' })))

        await user.click(await screen.findByText('Olivia Bachata'))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Make public' })).toBeEnabled())
        await user.click(screen.getByRole('button', { name: 'Make public' }))
        await waitFor(() => expect(api.decideAdminChange).toHaveBeenCalledWith(
            2,
            expect.objectContaining({ decision: 'accept', calendar_id: 'cal-public' }),
        ))
    })

    it('asks whether to notify attendees before applying an edit', async () => {
        vi.mocked(api.fetchAdminChanges).mockResolvedValue({
            items: [
                change({
                    kind: 'edit',
                    changes: { location: { old: 'Studio', new: 'Club' } },
                    material_fields: ['location'],
                    affected_attendees: 2,
                }),
                change({ id: 2, kind: 'edit', event: { ...change({}).event!, title: 'Quiet Kizomba' } }),
            ],
            total: 2,
            kinds: [{ value: 'edit', label: 'Edit', count: 2 }],
            sources: [{ value: 'sync', label: 'Google Calendar', count: 2 }],
        })
        const user = userEvent.setup()
        render(<MemoryRouter><ReviewPanel isOpen onClose={() => { }} /></MemoryRouter>)

        await user.click(await screen.findByText('Quiet Kizomba'))
        expect(screen.getByRole('checkbox', { name: /nobody has saved or is going yet/ })).toBeDisabled()

        await user.click(screen.getByText('Friday Salsa'))
        expect(screen.getByRole('checkbox', { name: 'Notify 2 attendees about this change' })).toBeChecked()
        await user.click(screen.getByRole('button', { name: 'Apply' }))
        await waitFor(() => expect(api.decideAdminChange).toHaveBeenCalledWith(1, expect.objectContaining({ decision: 'accept', notify: true })))
    })

    it('applies the same Google change to every date it was made on', async () => {
        vi.mocked(api.fetchAdminChanges).mockResolvedValue({
            items: [
                change({
                    kind: 'edit',
                    changes: { start: { old: '2026-10-16T20:00:00Z', new: '2026-10-16T21:00:00Z' } },
                    material_fields: ['start'],
                    affected_attendees: 1,
                    series_dates: 4,
                    series_affected_attendees: 6,
                    group_size: 4,
                }),
            ],
            total: 1,
            kinds: [{ value: 'edit', label: 'Edit', count: 1 }],
            sources: [{ value: 'sync', label: 'Google Calendar', count: 1 }],
        })
        const user = userEvent.setup()
        render(<MemoryRouter><ReviewPanel isOpen onClose={() => { }} /></MemoryRouter>)

        await user.click(await screen.findByText('Start · on 4 dates'))
        expect(screen.getByRole('checkbox', { name: 'Notify 1 attendee about this change' })).toBeChecked()
        await user.click(screen.getByRole('radio', { name: 'All 4 dates with this change' }))
        expect(screen.getByRole('checkbox', { name: 'Notify 6 attendees about this change' })).toBeChecked()
        await user.click(screen.getByRole('button', { name: 'Apply' }))

        await waitFor(() => expect(api.decideAdminChange).toHaveBeenCalledWith(1, expect.objectContaining({ scope: 'series', notify: true })))
    })

    it('keeps a time change on its date and says when an owner edit covers the series', async () => {
        vi.mocked(api.fetchAdminChanges).mockResolvedValue({
            items: [
                change({
                    kind: 'edit',
                    source: 'organizer',
                    changes: { start: { old: '2026-10-16T20:00:00Z', new: '2026-10-16T21:00:00Z' } },
                    series_dates: 3,
                }),
                change({
                    id: 2,
                    kind: 'edit',
                    source: 'submitter',
                    changes: { title: { old: 'Olivia Bachata', new: 'Olivia Kizomba' } },
                    series_dates: 4,
                    event: { ...change({}).event!, title: 'Olivia Bachata' },
                }),
            ],
            total: 2,
            kinds: [{ value: 'edit', label: 'Edit', count: 2 }],
            sources: [],
        })
        const user = userEvent.setup()
        render(<MemoryRouter><ReviewPanel isOpen onClose={() => { }} /></MemoryRouter>)

        await user.click(await screen.findByText('Friday Salsa'))
        expect(screen.getByRole('radio', { name: 'All 3 upcoming dates' })).toBeDisabled()
        expect(screen.getByText('Time changes apply to this date only.')).toBeInTheDocument()

        await user.click(screen.getByText('Olivia Bachata'))
        expect(screen.getByTestId('change-scope')).toHaveTextContent('Applies to all 4 upcoming dates.')
        expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    })
})
