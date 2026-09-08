import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import TagBadges from './TagBadges'
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext'
import { renderWithProviders } from '../test/render'
import type { Tag } from '../types'

// FeatureFlagsProvider fetches site settings on mount — stub it so the badge
// rendering is exercised with the default flags and no network.
vi.mock('../api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api')>()
    return {
        ...actual,
        fetchSettings: vi.fn(async () => {
            throw new Error('settings disabled in test')
        }),
    }
})

function tag(id: number, label: string): Tag {
    return {
        id,
        slug: label.toLowerCase(),
        label,
        color: '#111',
        ordinal: id,
        group_slug: 'dance-style',
        group_label: 'Dance style',
        group_color: null,
        enabled: true,
        is_hero_filter: false,
        hero_ordinal: null,
    }
}

describe('TagBadges overflow chip', () => {
    it('renders the "+x" overflow as a button that invokes onOverflowClick', async () => {
        const onOverflowClick = vi.fn()
        const { user } = renderWithProviders(
            <FeatureFlagsProvider>
                <TagBadges
                    tags={[tag(1, 'Salsa'), tag(2, 'Bachata'), tag(3, 'Kizomba')]}
                    maxVisible={1}
                    forceBadge
                    neutral
                    onOverflowClick={onOverflowClick}
                />
            </FeatureFlagsProvider>,
        )

        const overflow = await screen.findByRole('button', { name: 'Show 2 more tags' })
        expect(overflow).toHaveTextContent('+2')
        await user.click(overflow)
        expect(onOverflowClick).toHaveBeenCalledTimes(1)
    })

    it('renders the "+x" overflow as static text when no handler is provided', async () => {
        renderWithProviders(
            <FeatureFlagsProvider>
                <TagBadges
                    tags={[tag(1, 'Salsa'), tag(2, 'Bachata'), tag(3, 'Kizomba')]}
                    maxVisible={1}
                    forceBadge
                    neutral
                />
            </FeatureFlagsProvider>,
        )

        expect(await screen.findByText('+2')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Show 2 more tags' })).toBeNull()
    })
})
