import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import BottomNav from './BottomNav'

// The For-You "new" dot pulls in Auth/Preferences/FeatureFlags + a live lens
// fetch; stub it so the nav renders without that provider tree.
vi.mock('../hooks/useForYouHasNew', () => ({
    useForYouHasNew: () => false,
}))

function renderAt(path: string) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <BottomNav />
        </MemoryRouter>,
    )
}

describe('BottomNav', () => {
    it('renders the four primary destinations', () => {
        renderAt('/')
        expect(screen.getByRole('link', { name: 'Explore' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'For You' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Tribe' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Mine' })).toBeInTheDocument()
    })

    it('marks Explore active on the root route', () => {
        renderAt('/')
        expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'Mine' })).not.toHaveAttribute('aria-current')
    })

    it('marks Mine active on /mine but not Tribe', () => {
        renderAt('/mine')
        expect(screen.getByRole('link', { name: 'Mine' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'Tribe' })).not.toHaveAttribute('aria-current')
    })

    it('marks Tribe active on the tribe route', () => {
        renderAt('/tribe')
        expect(screen.getByRole('link', { name: 'Tribe' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'Mine' })).not.toHaveAttribute('aria-current')
    })
})
