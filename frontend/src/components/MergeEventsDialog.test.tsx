import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import MergeEventsDialog from './MergeEventsDialog'
import * as api from '../api'
import type { MergePreview } from '../api'

vi.mock('../api', () => ({
    fetchMergePreview: vi.fn(),
    mergeEvents: vi.fn(),
}))

const time = { start: '2030-10-04T18:00:00Z', end: '2030-10-04T21:00:00Z', all_day: false, timezone: null }
const price = { price_min: null, price_max: null, price_currency: null, price_is_free: null }

const preview: MergePreview = {
    events: [
        {
            event_id: 'keep',
            calendar_id: 'src',
            status: 'published',
            is_submission: false,
            values: { title: 'Salsa Night', description: null, location: 'Studio A', time, links: null, price, picture: null },
            tag_ids: [1],
            counts: { saved: 1, going: 0 },
        },
        {
            event_id: 'dup',
            calendar_id: 'src',
            status: 'published',
            is_submission: false,
            values: { title: 'Salsa Night', description: null, location: 'Studio A, Berlin', time, links: null, price, picture: null },
            tag_ids: [1, 2],
            counts: { saved: 2, going: 1 },
        },
    ],
    fields: [
        { key: 'title', label: 'Title', identical: true },
        { key: 'location', label: 'Venue', identical: false },
        { key: 'time', label: 'Date & time', identical: true },
    ],
    affected_users: 2,
}

describe('MergeEventsDialog', () => {
    it('merges with the picked venue after a confirmation', async () => {
        vi.mocked(api.fetchMergePreview).mockResolvedValue(preview)
        vi.mocked(api.mergeEvents).mockResolvedValue({ target_event_id: 'keep', merged_event_ids: ['dup'], moved: {}, notified: 1 })
        const onMerged = vi.fn()
        render(
            <MemoryRouter>
                <MergeEventsDialog eventIds={['keep', 'dup']} onClose={() => { }} onMerged={onMerged} />
            </MemoryRouter>,
        )

        expect(await screen.findByText(/2 identical fields: Title, Date & time/)).toBeInTheDocument()
        await user().click(screen.getByRole('radio', { name: 'Venue from Salsa Night', checked: false }))
        expect(screen.getByTestId('merge-result-location')).toHaveTextContent('Studio A, Berlin')
        await user().click(screen.getByRole('button', { name: 'Merge…' }))
        await user().click(screen.getByRole('button', { name: 'Yes, merge 2 events' }))

        expect(api.mergeEvents).toHaveBeenCalledWith({
            target_event_id: 'keep',
            event_ids: ['dup'],
            fields: { location: 'dup' },
            combine_tags: true,
            combine_links: true,
            note: null,
            notify: true,
        })
        expect(onMerged).toHaveBeenCalled()
    })
})

function user() {
    return userEvent.setup()
}
