import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import BottomNav from './BottomNav'
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext'

// The For-You "new" dot pulls in Auth/Preferences/FeatureFlags + a live lens
// fetch; stub it so the nav renders without that provider tree.
vi.mock('../hooks/useForYouHasNew', () => ({
    useForYouHasNew: () => false,
}))

function renderAt(path: string, browseNavEnabled = false) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <FeatureFlagsContext.Provider value={{ flags: { ...defaultFlags, browseNavEnabled }, updateFlag: vi.fn() }}>
                <BottomNav />
            </FeatureFlagsContext.Provider>
        </MemoryRouter>,
    )
}

describe('BottomNav', () => {
    it('renders the four primary destinations', () => {
        renderAt('/')
        expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'My Events' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Tribe' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Passport' })).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Browse' })).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'For You' })).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'MyDance' })).not.toBeInTheDocument()
    })

    it('marks Home active on the root route', () => {
        renderAt('/')
        expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'Passport' })).not.toHaveAttribute('aria-current')
    })

    it('marks My Events active on its top-level route', () => {
        renderAt('/my-events')
        expect(screen.getByRole('link', { name: 'My Events' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'Tribe' })).not.toHaveAttribute('aria-current')
    })

    it('marks Tribe active on the tribe route', () => {
        renderAt('/tribe')
        expect(screen.getByRole('link', { name: 'Tribe' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'Passport' })).not.toHaveAttribute('aria-current')
    })

    it('marks Passport active on its top-level route', () => {
        renderAt('/passport')
        expect(screen.getByRole('link', { name: 'Passport' })).toHaveAttribute('aria-current', 'page')
    })

    it('inserts Browse after Home and gives it ownership of Browse routes when enabled', () => {
        renderAt('/browse', true)
        const links = screen.getAllByRole('link')
        expect(links.map((link) => link.textContent)).toEqual(['Home', 'Browse', 'My Events', 'Tribe', 'Passport'])
        expect(screen.getByRole('link', { name: 'Browse' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
    })

    it('keeps Browse routes under Home while Browse navigation is disabled', () => {
        renderAt('/browse')
        expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    })
})
