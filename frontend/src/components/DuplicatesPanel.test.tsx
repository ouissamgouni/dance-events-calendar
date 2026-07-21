import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import DuplicatesPanel from './DuplicatesPanel'
import { server } from '../test/server'

const notifyAdminDataChangedMock = vi.fn()

vi.mock('../hooks/useAdminCounters', () => ({
    notifyAdminDataChanged: () => notifyAdminDataChangedMock(),
}))

beforeEach(() => {
    notifyAdminDataChangedMock.mockClear()
})

const group = {
    id: 1,
    status: 'pending',
    source: 'auto',
    kept_event_id: null,
    created_at: '2026-07-01T10:00:00Z',
    resolved_at: null,
    events: [
        {
            event_id: 'evt-1',
            title: 'Salsa Night',
            start: '2026-07-10T20:00:00Z',
            end: '2026-07-10T23:00:00Z',
            calendar_id: 'cal-1',
            is_hidden: false,
            is_blocked: false,
            rejected_duplicate_reason: null,
        },
        {
            event_id: 'evt-2',
            title: 'Salsa Nite',
            start: '2026-07-10T21:00:00Z',
            end: '2026-07-11T00:00:00Z',
            calendar_id: 'cal-1',
            is_hidden: false,
            is_blocked: false,
            rejected_duplicate_reason: null,
        },
    ],
}

describe('DuplicatesPanel', () => {
    it('renders pending duplicate groups and lets the admin keep an event', async () => {
        server.use(
            http.get('*/api/admin/duplicates', () =>
                HttpResponse.json({ items: [group], total: 1 }),
            ),
            http.post('*/api/admin/duplicates/1/keep', () =>
                HttpResponse.json({
                    ...group,
                    status: 'resolved',
                    kept_event_id: 'evt-1',
                }),
            ),
        )

        const user = userEvent.setup()
        const onClose = vi.fn()
        const onOpenEvent = vi.fn()

        render(<DuplicatesPanel isOpen onClose={onClose} onOpenEvent={onOpenEvent} />)

        expect(await screen.findByText('Salsa Night')).toBeInTheDocument()
        expect(screen.getByText('Salsa Nite')).toBeInTheDocument()

        await user.click(screen.getByText('Salsa Night'))
        expect(onOpenEvent).toHaveBeenCalledWith('evt-1')

        const keepButtons = screen.getAllByRole('button', { name: 'Keep' })
        await user.click(keepButtons[0])

        await waitFor(() => expect(notifyAdminDataChangedMock).toHaveBeenCalled())
        // Pending tab removes the resolved group from view.
        await waitFor(() => expect(screen.queryByText('Salsa Night')).not.toBeInTheDocument())
    })

    it('dismisses a group as not-duplicates', async () => {
        server.use(
            http.get('*/api/admin/duplicates', () =>
                HttpResponse.json({ items: [group], total: 1 }),
            ),
            http.post('*/api/admin/duplicates/1/dismiss', () =>
                HttpResponse.json({ ...group, status: 'dismissed' }),
            ),
        )

        const user = userEvent.setup()
        render(<DuplicatesPanel isOpen onClose={vi.fn()} />)

        expect(await screen.findByText('Salsa Night')).toBeInTheDocument()

        await user.click(screen.getByText('Not duplicates — dismiss group'))

        await waitFor(() => expect(notifyAdminDataChangedMock).toHaveBeenCalled())
        await waitFor(() => expect(screen.queryByText('Salsa Night')).not.toBeInTheDocument())
    })

    it('triggers a manual scan', async () => {
        let scanCalled = false
        server.use(
            http.get('*/api/admin/duplicates', () =>
                HttpResponse.json({ items: [], total: 0 }),
            ),
            http.post('*/api/admin/duplicates/scan', () => {
                scanCalled = true
                return HttpResponse.json({
                    id: 5,
                    scan_type: 'manual_pair',
                    triggered_by_event_id: null,
                    started_at: '2026-07-01T10:00:00Z',
                    finished_at: '2026-07-01T10:00:05Z',
                    candidates_found: 0,
                    groups_created: 0,
                    status: 'completed',
                })
            }),
        )

        const user = userEvent.setup()
        render(<DuplicatesPanel isOpen onClose={vi.fn()} />)

        await screen.findByText('No duplicate groups')
        await user.click(screen.getByRole('button', { name: 'Scan now' }))

        await waitFor(() => expect(scanCalled).toBe(true))
    })

    it('shows scan history in the history tab', async () => {
        server.use(
            http.get('*/api/admin/duplicates/history', () =>
                HttpResponse.json({
                    items: [
                        {
                            id: 9,
                            scan_type: 'full',
                            triggered_by_event_id: null,
                            started_at: '2026-07-01T10:00:00Z',
                            finished_at: '2026-07-01T10:01:00Z',
                            candidates_found: 3,
                            groups_created: 1,
                            status: 'completed',
                        },
                    ],
                    total: 1,
                }),
            ),
            http.get('*/api/admin/duplicates', () =>
                HttpResponse.json({ items: [], total: 0 }),
            ),
        )

        const user = userEvent.setup()
        render(<DuplicatesPanel isOpen onClose={vi.fn()} />)

        await user.click(screen.getByRole('button', { name: 'history' }))

        expect(await screen.findByText(/3 candidates found, 1 group created/)).toBeInTheDocument()
    })
})
