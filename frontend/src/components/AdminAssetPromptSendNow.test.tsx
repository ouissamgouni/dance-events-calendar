import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AdminAssetPromptSendNow from './AdminAssetPromptSendNow'
import * as api from '../api'
import type { AssetPromptCandidate, AssetPromptCandidatesResponse, EventSearchResult } from '../api'

vi.mock('../api', () => ({
    searchEvents: vi.fn(),
    fetchAssetPromptCandidates: vi.fn(),
    sendAssetPromptNow: vi.fn(),
}))

const EVENT = { event_id: 'fest', title: 'Salsa Fest', start: '2099-05-01T20:00:00Z' } as EventSearchResult

function candidate(handle: string, extra: Partial<AssetPromptCandidate> = {}): AssetPromptCandidate {
    return {
        user_id: `id-${handle}`,
        email: `${handle}@example.com`,
        name: handle,
        handle,
        blocker: null,
        email_enabled: true,
        push_enabled: true,
        has_push_subscription: true,
        curator_marked: false,
        notification: null,
        ...extra,
    }
}

const SENT = { created_at: '2099-04-01T10:00:00Z', read_at: null, emailed_at: '2099-04-01T10:00:00Z', pushed_at: '2099-04-01T10:00:00Z' }

const RESPONSE: AssetPromptCandidatesResponse = {
    event_id: 'fest',
    title: 'Salsa Fest',
    start: '2099-05-01T20:00:00Z',
    end: '2099-05-03T20:00:00Z',
    ticket_likely: false,
    ticket_likely_reason: null,
    ineligible_reason: null,
    candidates: [
        candidate('mia'),
        candidate('ana', { notification: SENT }),
        candidate('leo', { notification: { ...SENT, pushed_at: null } }),
        candidate('kim', { blocker: 'has_ticket' }),
    ],
}

beforeEach(() => vi.clearAllMocks())

async function pickEvent() {
    const user = userEvent.setup()
    vi.mocked(api.searchEvents).mockResolvedValue([EVENT])
    vi.mocked(api.fetchAssetPromptCandidates).mockResolvedValue(RESPONSE)
    render(<AdminAssetPromptSendNow kind="ticket" />)
    await user.type(screen.getByLabelText('Search event for ticket prompt'), 'salsa')
    await user.click(await screen.findByRole('button', { name: /Salsa Fest/ }))
    await screen.findByLabelText('Select mia')
    return user
}

describe('AdminAssetPromptSendNow', () => {
    it('pre-selects users missing a channel and locks blocked ones', async () => {
        await pickEvent()

        expect(api.searchEvents).toHaveBeenCalledWith('salsa', expect.objectContaining({ dateScope: 'upcoming' }))
        expect(screen.getByLabelText('Select mia')).toBeChecked()
        expect(screen.getByLabelText('Select leo')).toBeChecked()
        expect(screen.getByLabelText('Select ana')).not.toBeChecked()
        expect(screen.getByLabelText('Select kim')).toBeDisabled()
        expect(screen.getByText('has ticket')).toBeInTheDocument()
        expect(screen.getByText(/Not ticket-likely/)).toBeInTheDocument()
    })

    it('sends the selected users and checked channels', async () => {
        vi.mocked(api.sendAssetPromptNow).mockResolvedValue({
            in_app_created: 1, in_app_resurfaced: 0, emailed: 1, pushed: 2,
            results: [
                { user_id: 'id-mia', email: 'mia@example.com', status: 'sent' },
                { user_id: 'id-leo', email: 'leo@example.com', status: 'sent' },
            ],
        })
        const user = await pickEvent()

        await user.click(screen.getByRole('checkbox', { name: 'In-app' }))
        await user.click(screen.getByRole('button', { name: 'Send now (2)' }))

        await waitFor(() => expect(api.sendAssetPromptNow).toHaveBeenCalledWith({
            kind: 'ticket',
            event_id: 'fest',
            user_ids: ['id-mia', 'id-leo'],
            channels: ['email', 'push'],
            resend: false,
        }))
        expect(await screen.findByText(/2 of 2 user\(s\) sent/)).toBeInTheDocument()
        expect(api.fetchAssetPromptCandidates).toHaveBeenCalledTimes(2)
    })
})
