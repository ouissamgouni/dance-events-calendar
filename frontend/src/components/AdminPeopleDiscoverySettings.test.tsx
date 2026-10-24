import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import AdminPeopleDiscoverySettings from './AdminPeopleDiscoverySettings'

const stats = {
    days: 30, shown: 4, dismissed: 2, followed: 2, follows: 3, forced_shown: 1,
    joined_created: 5, joined_pushed: 1, joined_push_failed: 1, joined_followed: 2,
}

describe('AdminPeopleDiscoverySettings', () => {
    it('shows stats and forces the sheet for all users after a preview', async () => {
        const bodies: Record<string, unknown>[] = []
        server.use(
            http.get('*/api/admin/people-discovery/stats', () => HttpResponse.json(stats)),
            http.post('*/api/admin/people-prompt/force', async ({ request }) => {
                const body = (await request.json()) as Record<string, unknown>
                bodies.push(body)
                return HttpResponse.json({
                    dry_run: body.dry_run, all_users: true, warning: null, targeted: 12,
                    forced: body.dry_run ? 0 : 12, users: [],
                })
            }),
        )
        const onMessage = vi.fn()
        render(<AdminPeopleDiscoverySettings onMessage={onMessage} />)

        expect(await screen.findByText(/Sheet: shown 4 · dismissed 2 · followed 2 \(50%\)/)).toBeInTheDocument()
        expect(screen.getByText(/Joined: notified 5 in-app · pushes sent 1 \(1 failed\) · followed back 2/)).toBeInTheDocument()

        const [allUsers] = screen.getAllByRole('checkbox', { name: 'All users' })
        await userEvent.click(allUsers)
        expect(screen.queryByRole('button', { name: 'Pick users' })).not.toBeInTheDocument()

        const [preview] = screen.getAllByRole('button', { name: 'Preview' })
        await userEvent.click(preview)
        expect(await screen.findByText(/12 user\(s\) targeted/)).toBeInTheDocument()

        const [confirm] = screen.getAllByRole('button', { name: 'Confirm' })
        await userEvent.click(confirm)
        await waitFor(() => expect(onMessage).toHaveBeenCalledWith("People sheet forced for 12 user(s)' next session."))
        expect(bodies).toEqual([{ all_users: true, dry_run: true }, { all_users: true, dry_run: false }])
    })

    it('previews the joined notification for all recent joiners', async () => {
        let body: Record<string, unknown> | null = null
        server.use(
            http.get('*/api/admin/people-discovery/stats', () => HttpResponse.json(stats)),
            http.post('*/api/admin/people-joined/force', async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({
                    dry_run: true, created: 0, pushed: 0,
                    joiners: [{
                        joiner_user_id: 'j1', joiner_handle: 'nina', joiner_display_name: 'Nina', joiner_warning: null,
                        created: 0, pushed: 0,
                        candidates: [{ user_id: 'u1', handle: 'eli', display_name: 'Eli', regular_mutual: 1, curator_mutual: 0, reason: null, push_enabled: true }],
                    }],
                })
            }),
        )
        render(<AdminPeopleDiscoverySettings onMessage={vi.fn()} />)

        await userEvent.click(await screen.findByRole('checkbox', { name: 'All recent joiners' }))
        const previews = screen.getAllByRole('button', { name: 'Preview' })
        await userEvent.click(previews[previews.length - 1])

        expect(await screen.findByText('Nina')).toBeInTheDocument()
        expect(screen.getByText(/1 regular · 0 curator · will notify/)).toBeInTheDocument()
        expect(body).toEqual({ all_recent_joiners: true, channels: ['app', 'push'], dry_run: true })
    })
})
