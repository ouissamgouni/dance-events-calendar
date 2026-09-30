import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import AudiencePicker from './AudiencePicker'
import { renderWithProviders } from '../test/render'
import { makeUser } from '../test/handlers'
import { server } from '../test/server'

describe('AudiencePicker', () => {
    it('links the zero-friends hint to Tribe People in the sheet layout', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ friend_count: 0 }))),
        )

        renderWithProviders(
            <AudiencePicker
                value="friends"
                onChange={vi.fn()}
                size="sheet"
                ariaLabel="Attendance visibility"
            />,
        )

        const hint = await screen.findByTestId('audience-zero-friends-hint')
        expect(hint).toHaveClass('text-sm')
        expect(screen.getByRole('link', { name: /find people to follow/i })).toHaveAttribute('href', '/tribe/network')
        expect(screen.getByRole('radiogroup', { name: 'Attendance visibility' })).toHaveClass('flex', 'w-full')
        expect(screen.getAllByRole('radio')).toHaveLength(3)
    })
})
