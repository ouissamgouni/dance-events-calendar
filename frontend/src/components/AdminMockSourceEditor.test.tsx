import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AdminMockSourceEditor from './AdminMockSourceEditor'
import * as api from '../api'
import type { MockSourceEvent } from '../types'

vi.mock('../api', () => ({
    fetchMockSourceEvent: vi.fn(),
    editMockSourceEvent: vi.fn(),
    deleteMockSourceEvent: vi.fn(),
}))

const SOURCE: MockSourceEvent = {
    event_id: 'ev-sync-live',
    calendar_id: 'salsa-src',
    title: 'Friday Salsa',
    description: null,
    location: 'Studio A',
    start: '2030-10-04T20:00:00',
    end: '2030-10-04T23:30:00',
    all_day: false,
    edited: false,
    deleted: false,
}

beforeEach(() => vi.clearAllMocks())

describe('AdminMockSourceEditor', () => {
    it('renders nothing outside mock mode', async () => {
        vi.mocked(api.fetchMockSourceEvent).mockResolvedValue(null)
        const { container } = render(<AdminMockSourceEditor eventId="e" onSynced={vi.fn()} />)
        await waitFor(() => expect(api.fetchMockSourceEvent).toHaveBeenCalled())
        expect(container).toBeEmptyDOMElement()
    })

    it('sends only the changed fields and reloads after the sync', async () => {
        const user = userEvent.setup()
        const onSynced = vi.fn()
        vi.mocked(api.fetchMockSourceEvent).mockResolvedValue(SOURCE)
        vi.mocked(api.editMockSourceEvent).mockResolvedValue({
            source: { ...SOURCE, location: 'Studio B', edited: true },
            synced: true,
            upserted: 1,
            deleted: 0,
        })
        render(<AdminMockSourceEditor eventId="ev-sync-live" onSynced={onSynced} />)

        await user.click(await screen.findByRole('button', { name: 'Edit at source' }))
        const location = screen.getByLabelText('Location')
        await user.clear(location)
        await user.type(location, 'Studio B')
        await user.click(screen.getByRole('button', { name: 'Save & sync' }))

        await waitFor(() => expect(api.editMockSourceEvent).toHaveBeenCalledWith('ev-sync-live', { location: 'Studio B' }))
        expect(onSynced).toHaveBeenCalled()
        expect(await screen.findByText('Edited at the source.')).toBeInTheDocument()
    })
})
