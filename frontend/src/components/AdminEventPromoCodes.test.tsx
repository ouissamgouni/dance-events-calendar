import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AdminEventPromoCodes from './AdminEventPromoCodes'
import * as api from '../api'
import type { PromoCodeAdmin } from '../types'

vi.mock('../api', () => ({
    approveAdminPromoCode: vi.fn(),
    createAdminPromoCode: vi.fn(),
    fetchAdminPromoCodes: vi.fn(),
    rejectAdminPromoCode: vi.fn(),
    updateAdminPromoCode: vi.fn(),
}))

const CREATED = {
    id: 'p1',
    event_id: 'ev-1',
    code: 'ADMIN15',
    description: '15% off',
    source_url: null,
    expires_at: null,
    status: 'approved',
    submitter: { user_id: 'u-admin', handle: 'admin', display_name: 'Admin', avatar_url: null },
    created_at: '2099-01-01T00:00:00Z',
    updated_at: '2099-01-01T00:00:00Z',
    admin_notes: null,
    reviewed_at: '2099-01-01T00:00:00Z',
    reviewed_by: 'admin@example.com',
    event_title: 'Salsa Fest',
} as PromoCodeAdmin

beforeEach(() => vi.clearAllMocks())

describe('AdminEventPromoCodes', () => {
    it('adds an approved promo code from the panel', async () => {
        const user = userEvent.setup()
        vi.mocked(api.fetchAdminPromoCodes).mockResolvedValue([])
        vi.mocked(api.createAdminPromoCode).mockResolvedValue(CREATED)
        render(<AdminEventPromoCodes eventId="ev-1" overrideValue={null} onOverrideChange={vi.fn()} />)

        await user.click(screen.getByRole('button', { name: /Promo codes/ }))
        await user.click(await screen.findByRole('button', { name: '+ Add promo code' }))
        const submit = screen.getByRole('button', { name: 'Add & approve' })
        expect(submit).toBeDisabled()
        await user.type(screen.getByLabelText('Code'), '  ADMIN15 ')
        await user.type(screen.getByLabelText('Description'), '15% off')
        await user.click(submit)

        expect(api.createAdminPromoCode).toHaveBeenCalledWith('ev-1', {
            code: 'ADMIN15',
            description: '15% off',
            source_url: null,
            expires_at: null,
        })
        expect(await screen.findByText('ADMIN15')).toBeInTheDocument()
        expect(screen.getByText('approved')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Add & approve' })).not.toBeInTheDocument()
    })
})
