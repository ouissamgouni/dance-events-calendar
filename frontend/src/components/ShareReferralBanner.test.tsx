import { describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import ShareReferralBanner from './ShareReferralBanner'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

function storeReferral(inv?: string) {
    localStorage.setItem('movida_referral_src', JSON.stringify({
        src: 'sharer01',
        eventId: 'evt-1',
        capturedAt: Date.now(),
        ...(inv ? { inv } : {}),
    }))
}

describe('ShareReferralBanner', () => {
    it('offers mutual friendship for a valid friend-invite link', async () => {
        storeReferral('INV123')
        const redeemed: unknown[] = []
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ share_code: 'viewer01' }))),
            http.get('*/api/social/share-source/:code', ({ request }) =>
                HttpResponse.json({
                    handle: 'sharer',
                    display_name: 'Sharer',
                    avatar_url: null,
                    friend_invite: new URL(request.url).searchParams.get('inv') === 'INV123',
                }),
            ),
            http.post('*/api/auth/redeem-referral', async ({ request }) => {
                redeemed.push(await request.json())
                return HttpResponse.json({ inviter_handle: 'sharer', mutual_follow_created: true })
            }),
        )
        renderWithProviders(<ShareReferralBanner />)

        expect(await screen.findByText(/invited you/)).toBeInTheDocument()
        expect(screen.getByRole('checkbox', { name: 'Become friends' })).toBeChecked()
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

        expect(await screen.findByTestId('share-referral-banner-redeemed')).toHaveTextContent('You and @sharer are now friends.')
        expect(redeemed).toEqual([{ code: 'INV123', consent: true }])
    })

    it('falls back to the one-way follow when the invite code is not the sharer\'s', async () => {
        storeReferral('OTHER1')
        const followed: unknown[] = []
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ share_code: 'viewer01' }))),
            http.get('*/api/social/share-source/:code', () =>
                HttpResponse.json({ handle: 'sharer', display_name: 'Sharer', avatar_url: null, friend_invite: false }),
            ),
            http.post('*/api/auth/redeem-share-follow', async ({ request }) => {
                followed.push(await request.json())
                return HttpResponse.json({ sharer_handle: 'sharer', follow_created: true })
            }),
        )
        renderWithProviders(<ShareReferralBanner />)

        expect(await screen.findByText(/You arrived via/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

        expect(await screen.findByTestId('share-referral-banner-redeemed')).toHaveTextContent("You're now following @sharer.")
        expect(followed).toEqual([{ share_code: 'sharer01', consent: true }])
    })
})
