import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import BottomNav from './BottomNav'
import { FeatureFlagsContext } from '../context/FeatureFlagsContext'

// The For-You "new" dot pulls in Auth/Preferences/FeatureFlags + a live lens
// fetch; stub it so the nav renders without that provider tree.
vi.mock('../hooks/useForYouHasNew', () => ({
    useForYouHasNew: () => false,
}))

function renderAt(path: string, contextValue?: { flags: any; updateFlag: any }) {
    const defaultContext = {
        flags: {
            myEventsNavEnabled: true,
            showPrices: false,
            showPopularity: false,
            showRatings: false,
            popularityThreshold: 10,
            followingBadgeEnabled: false,
            unseenStateEnabled: false,
            trendingEnabled: false,
            trendingBannerEnabled: false,
            trendingFloorGoing: 3,
            trendingTopN: 3,
            trendingTopPercent: 100,
            eventColorBarColor: '#64748b',
            tagSortMode: 'group' as const,
            goingButtonIconVariant: 'hand' as const,
            promoCodesEnabled: false,
            organizerClaimsEnabled: false,
            forYouRailEnabled: false,
            yourNextEventsRailEnabled: false,
            networkGoingSnapshotEnabled: true,
            myEventsRouteEnabled: false,
            eventReviewSizeStepEnabled: true,
            tagAsBadge: false,
            tagBadgeColored: false,
            trendingTrailRichEnabled: false,
            tagsPerCard: 3,
        },
        updateFlag: () => { },
    }

    const value = contextValue || defaultContext

    return render(
        <FeatureFlagsContext.Provider value={value}>
            <MemoryRouter initialEntries={[path]}>
                <BottomNav />
            </MemoryRouter>
        </FeatureFlagsContext.Provider>,
    )
}

describe('BottomNav', () => {
    it('renders the five primary destinations when my events nav is enabled', () => {
        renderAt('/')
        expect(screen.getByRole('link', { name: 'Explore' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'For You' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Tribe' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'My Events' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'MyDance' })).toBeInTheDocument()
    })

    it('hides My Events when nav flag is disabled', () => {
        renderAt('/', {
            flags: { myEventsNavEnabled: false } as any,
            updateFlag: () => { },
        })
        expect(screen.queryByRole('link', { name: 'My Events' })).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Explore' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'MyDance' })).toBeInTheDocument()
    })

    it('marks Explore active on the root route', () => {
        renderAt('/')
        expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'MyDance' })).not.toHaveAttribute('aria-current')
    })

    it('marks MyDance active on /mine but not Tribe', () => {
        renderAt('/mine')
        expect(screen.getByRole('link', { name: 'MyDance' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'Tribe' })).not.toHaveAttribute('aria-current')
    })

    it('marks Tribe active on the tribe route', () => {
        renderAt('/tribe')
        expect(screen.getByRole('link', { name: 'Tribe' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'MyDance' })).not.toHaveAttribute('aria-current')
    })
})
