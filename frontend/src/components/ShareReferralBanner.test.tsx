import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import ShareReferralBanner from './ShareReferralBanner'
import { ToastProvider } from './Toast'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'
import { useAuth } from '../context/AuthContext'
import { getSharePrompt, type SharePrompt } from '../hooks/useReferralAttribution'

function storePrompt(extra: Partial<SharePrompt> = {}) {
    sessionStorage.setItem('movida_share_prompt', JSON.stringify({ src: 'sharer01', eventId: 'evt-1', ...extra }))
}

function mockSource(fields: Record<string, unknown> = {}) {
    return http.get('*/api/social/share-source/:code', ({ request }) =>
        HttpResponse.json({
            handle: 'sharer',
            display_name: 'Sharer',
            avatar_url: null,
            friend_invite: new URL(request.url).searchParams.get('inv') === 'INV123',
            viewer_follows: false,
            viewer_is_friend: false,
            ...fields,
        }),
    )
}

const signedIn = () => http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ share_code: 'viewer01' })))

function renderSheet(route = '/event/evt-1') {
    return renderWithProviders(<ToastProvider><ShareReferralBanner /></ToastProvider>, { routerEntries: [route] })
}

describe('ShareReferralBanner (invite sheet)', () => {
    beforeEach(() => sessionStorage.clear())

    it('offers mutual friendship for a friend-invite link and confirms with a toast', async () => {
        storePrompt({ inv: 'INV123' })
        const redeemed: unknown[] = []
        server.use(
            signedIn(),
            mockSource(),
            http.post('*/api/auth/redeem-referral', async ({ request }) => {
                redeemed.push(await request.json())
                return HttpResponse.json({ inviter_handle: 'sharer', mutual_follow_created: true })
            }),
        )
        renderSheet()

        expect(await screen.findByText('Sharer invited you')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Become friends' }))

        expect(await screen.findByText('You and Sharer are now friends')).toBeInTheDocument()
        expect(redeemed).toEqual([{ code: 'INV123', consent: true }])
        expect(screen.queryByTestId('share-referral-sheet')).not.toBeInTheDocument()
        expect(getSharePrompt()).toBeNull()
    })

    it('falls back to a one-way follow when the invite code is not the sharer\'s', async () => {
        storePrompt({ inv: 'OTHER1' })
        const followed: unknown[] = []
        server.use(
            signedIn(),
            mockSource(),
            http.post('*/api/auth/redeem-share-follow', async ({ request }) => {
                followed.push(await request.json())
                return HttpResponse.json({ sharer_handle: 'sharer', follow_created: true })
            }),
        )
        renderSheet()

        expect(await screen.findByText('Sharer shared this event')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Follow Sharer' }))

        await waitFor(() => expect(followed).toEqual([{ share_code: 'sharer01', consent: true }]))
    })

    it('only shows on the shared event page', async () => {
        storePrompt({ inv: 'INV123' })
        server.use(signedIn(), mockSource())
        renderSheet('/browse')

        await new Promise((r) => setTimeout(r, 50))
        expect(screen.queryByTestId('share-referral-sheet')).not.toBeInTheDocument()
        expect(getSharePrompt()).not.toBeNull()
    })

    it('stays hidden and resolves when the viewer is already friends with the sharer', async () => {
        storePrompt({ inv: 'INV123' })
        server.use(signedIn(), mockSource({ viewer_follows: true, viewer_is_friend: true }))
        renderSheet()

        await waitFor(() => expect(getSharePrompt()).toBeNull())
        expect(screen.queryByTestId('share-referral-sheet')).not.toBeInTheDocument()
    })

    it('"Not now" resolves the invite for this tab', async () => {
        storePrompt({ inv: 'INV123' })
        server.use(signedIn(), mockSource())
        renderSheet()

        fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))

        await waitFor(() => expect(screen.queryByTestId('share-referral-sheet')).not.toBeInTheDocument())
        expect(getSharePrompt()).toBeNull()
    })

    it('asks guests to sign up and remembers the intent', async () => {
        storePrompt({ inv: 'INV123' })
        server.use(mockSource())
        renderSheet()

        fireEvent.click(await screen.findByRole('button', { name: 'Sign up to become friends' }))

        expect(getSharePrompt()?.intent).toBe(true)
        await waitFor(() => expect(screen.queryByTestId('share-referral-sheet')).not.toBeInTheDocument())
    })

    it('accepts automatically once a guest who chose to sign up is signed in', async () => {
        storePrompt({ inv: 'INV123', intent: true })
        const redeemed: unknown[] = []
        server.use(
            signedIn(),
            mockSource(),
            http.post('*/api/auth/redeem-referral', async ({ request }) => {
                redeemed.push(await request.json())
                return HttpResponse.json({ inviter_handle: 'sharer', mutual_follow_created: true })
            }),
        )
        renderSheet('/onboarding/preferences')

        await waitFor(() => expect(redeemed).toEqual([{ code: 'INV123', consent: true }]))
        await waitFor(() => expect(getSharePrompt()).toBeNull())
    })

    it('drops the invite on sign-out so the next account on the device does not inherit it', async () => {
        storePrompt({ inv: 'INV123' })
        server.use(signedIn())
        function SignOut() {
            const { user, logout } = useAuth()
            return user ? <button type="button" onClick={() => void logout()}>Sign out</button> : null
        }
        renderWithProviders(<SignOut />)

        fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

        await waitFor(() => expect(sessionStorage.getItem('movida_share_prompt')).toBeNull())
    })
})
