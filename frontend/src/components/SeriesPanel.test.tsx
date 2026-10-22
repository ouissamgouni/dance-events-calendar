import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import SeriesPanel from './SeriesPanel'
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
    canonical_title: 'Weekly Salsa Social',
    created_at: '2026-07-01T10:00:00Z',
    resolved_at: null,
    events: [
        {
            event_id: 'evt-1',
            title: 'Weekly Salsa Social',
            start: '2026-07-10T20:00:00Z',
            end: '2026-07-10T23:00:00Z',
            calendar_id: 'cal-1',
            location: 'The Warehouse',
        },
        {
            event_id: 'evt-2',
            title: 'Weekly Salsa Social',
            start: '2026-07-17T20:00:00Z',
            end: '2026-07-17T23:00:00Z',
            calendar_id: 'cal-1',
            location: 'The Warehouse',
        },
    ],
}

describe('SeriesPanel', () => {
    it('renders pending series groups and lets the admin approve one', async () => {
        server.use(
            http.get('*/api/admin/series', () =>
                HttpResponse.json({ items: [group], total: 1 }),
            ),
            http.post('*/api/admin/series/1/approve', () =>
                HttpResponse.json({ ...group, status: 'resolved' }),
            ),
        )

        const user = userEvent.setup()
        const onClose = vi.fn()
        const onOpenEvent = vi.fn()

        render(<SeriesPanel isOpen onClose={onClose} onOpenEvent={onOpenEvent} />)

        expect(await screen.findAllByText('Weekly Salsa Social')).not.toHaveLength(0)

        await user.click(screen.getAllByText('Weekly Salsa Social')[1])
        expect(onOpenEvent).toHaveBeenCalledWith('evt-1')

        await user.click(screen.getByRole('button', { name: 'Approve series' }))

        await waitFor(() => expect(notifyAdminDataChangedMock).toHaveBeenCalled())
        await waitFor(() => expect(screen.queryByText('evt-1')).not.toBeInTheDocument())
    })

    it('dismisses a series as not-a-series', async () => {
        server.use(
            http.get('*/api/admin/series', () =>
                HttpResponse.json({ items: [group], total: 1 }),
            ),
            http.post('*/api/admin/series/1/dismiss', () =>
                HttpResponse.json({ ...group, status: 'dismissed' }),
            ),
        )

        const user = userEvent.setup()
        render(<SeriesPanel isOpen onClose={vi.fn()} />)

        await screen.findAllByText('Weekly Salsa Social')

        await user.click(screen.getByRole('button', { name: 'Not a series — dismiss' }))

        await waitFor(() => expect(notifyAdminDataChangedMock).toHaveBeenCalled())
    })

    it('splits an event off a series', async () => {
        server.use(
            http.get('*/api/admin/series', () =>
                HttpResponse.json({ items: [group], total: 1 }),
            ),
            http.post('*/api/admin/series/1/split', () =>
                HttpResponse.json({
                    dissolved: false,
                    series: { ...group, events: [group.events[0]] },
                }),
            ),
        )

        const user = userEvent.setup()
        render(<SeriesPanel isOpen onClose={vi.fn()} />)

        await screen.findAllByText('Weekly Salsa Social')

        const splitButtons = screen.getAllByRole('button', { name: 'Remove' })
        await user.click(splitButtons[1])

        await waitFor(() => expect(notifyAdminDataChangedMock).toHaveBeenCalled())
    })

    it('triggers a manual scan', async () => {
        let scanCalled = false
        server.use(
            http.get('*/api/admin/series', () =>
                HttpResponse.json({ items: [], total: 0 }),
            ),
            http.post('*/api/admin/series/scan', () => {
                scanCalled = true
                return HttpResponse.json({
                    id: 5,
                    scan_type: 'full',
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
        render(<SeriesPanel isOpen onClose={vi.fn()} />)

        await screen.findByText('No series groups')
        await user.click(screen.getByRole('button', { name: 'Scan now' }))

        await waitFor(() => expect(scanCalled).toBe(true))
    })

    it('shows scan history in the history tab', async () => {
        server.use(
            http.get('*/api/admin/series/history', () =>
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
            http.get('*/api/admin/series', () =>
                HttpResponse.json({ items: [], total: 0 }),
            ),
        )

        const user = userEvent.setup()
        render(<SeriesPanel isOpen onClose={vi.fn()} />)

        await user.click(screen.getByRole('button', { name: 'history' }))

        expect(await screen.findByText(/3 candidates found, 1 group created/)).toBeInTheDocument()
    })

    it('edits detection settings in the settings tab', async () => {
        const settings = {
            auto_detect_enabled: false,
            title_similarity_pct: 72,
            max_gap_days: 395,
            venue_radius_m: 300,
            max_distance_km: 50,
            cross_calendar_enabled: true,
            join_resolved_enabled: true,
            generic_title_words: ['salsa', 'festival'],
        }
        let saved: Record<string, unknown> | null = null
        server.use(
            http.get('*/api/admin/series', () => HttpResponse.json({ items: [], total: 0 })),
            http.get('*/api/admin/series/settings', () => HttpResponse.json(settings)),
            http.put('*/api/admin/series/settings', async ({ request }) => {
                saved = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({ ...settings, ...saved, generic_title_words: ['salsa'] })
            }),
        )

        const user = userEvent.setup()
        render(<SeriesPanel isOpen onClose={vi.fn()} />)

        await user.click(screen.getByRole('button', { name: 'settings' }))
        const threshold = await screen.findByLabelText('Title similarity (%)')

        await user.clear(threshold)
        await user.type(threshold, '20')
        expect(screen.getByText('Enter a whole number between 50 and 100')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled()

        await user.clear(threshold)
        await user.type(threshold, '85')
        await user.click(screen.getByLabelText('Match events across calendars'))
        await user.click(screen.getByRole('button', { name: 'Save settings' }))

        expect(await screen.findByText('Saved')).toBeInTheDocument()
        expect(saved).toMatchObject({ title_similarity_pct: 85, cross_calendar_enabled: false })
    })
})
