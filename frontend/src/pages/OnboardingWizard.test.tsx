import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import OnboardingWizard from './OnboardingWizard'
import { AuthProvider } from '../context/AuthContext'
import { PreferencesProvider } from '../context/PreferencesContext'
import { AttendanceSummariesProvider } from '../context/AttendanceSummariesContext'
import { SavedEventsProvider } from '../context/SavedEventsContext'
import { AttendingEventsProvider } from '../context/AttendingEventsContext'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'
import type { TagGroup } from '../types'

vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    TileLayer: () => null,
    Rectangle: () => null,
    Circle: () => null,
    CircleMarker: () => null,
    useMap: () => ({ fitBounds: vi.fn() }),
}))

vi.mock('../components/onboarding/OnboardingAreaEditor', () => ({
    default: ({ area, onBack, onContinue }: { area: { label: string }; onBack: () => void; onContinue: () => void }) => (
        <div><p>Editing {area.label}</p><button type="button" onClick={onBack}>Areas</button><button type="button" onClick={onContinue}>Continue</button></div>
    ),
}))

function makeTag(id: number, slug: string, label: string, groupSlug = 'dance-style') {
    return { id, slug, label, color: null, ordinal: id, group_slug: groupSlug, group_label: groupSlug === 'dance-style' ? 'Dance styles' : 'Reach', group_color: null, enabled: true, is_hero_filter: false, hero_ordinal: null }
}

const danceGroup: TagGroup = {
    id: 1, slug: 'dance-style', label: 'Dance styles', color: null, ordinal: 0,
    allow_multiple: true, enabled: true, onboarding_eligible: true,
    tags: [
        makeTag(10, 'salsa', 'Salsa'),
        makeTag(11, 'bachata', 'Bachata'),
        makeTag(12, 'zouk', 'Zouk'),
        makeTag(13, 'kizomba', 'Kizomba'),
        makeTag(14, 'mambo-on2', 'Mambo (On2)'),
        makeTag(15, 'cha-cha', 'Cha-Cha'),
    ],
}
const reachGroup: TagGroup = {
    id: 2, slug: 'reach', label: 'Reach', color: null, ordinal: 1,
    allow_multiple: true, enabled: true, onboarding_eligible: true,
    tags: [makeTag(20, 'international', 'International', 'reach'), makeTag(21, 'local', 'Local', 'reach')],
}

function renderWizard() {
    return render(
        <MemoryRouter initialEntries={['/onboarding/preferences?next=/']}>
            <AuthProvider><PreferencesProvider><AttendanceSummariesProvider><SavedEventsProvider><AttendingEventsProvider>
                <Routes><Route path="/onboarding/preferences" element={<OnboardingWizard />} /><Route path="/" element={<p>home page</p>} /></Routes>
            </AttendingEventsProvider></SavedEventsProvider></AttendanceSummariesProvider></PreferencesProvider></AuthProvider>
        </MemoryRouter>,
    )
}

function useBaseHandlers(overrides?: { onComplete?: () => void; onCreate?: (body: Record<string, unknown>) => void }) {
    server.use(
        http.get('*/api/auth/me', () => HttpResponse.json(makeUser({
            needs_onboarding: true, onboarded_at: null,
            preferences: { share_attendance_default: false, preferred_area: null, preferred_tag_ids: [], home_location: null, set_at: null },
        }))),
        http.get('*/api/tags', () => HttpResponse.json([danceGroup, reachGroup])),
        http.get('*/api/interest-profiles', () => HttpResponse.json([])),
        http.get('*/api/events/popular-cities', () => HttpResponse.json([{ city: 'Paris', country: 'France', count: 10, lat: 48.8566, lng: 2.3522 }])),
        http.patch('*/api/auth/preferences', async ({ request }) => {
            const body = await request.json() as Record<string, unknown>
            return HttpResponse.json({ share_attendance_default: false, preferred_area: body.preferred_area ?? null, preferred_tag_ids: body.preferred_tag_ids ?? [], home_location: body.home_location ?? null, set_at: new Date().toISOString() })
        }),
        http.post('*/api/interest-profiles', async ({ request }) => {
            const body = await request.json() as Record<string, unknown>
            overrides?.onCreate?.(body)
            return HttpResponse.json({ id: 42, ...body, notify_enabled: body.matches_enabled, created_at: new Date().toISOString() })
        }),
        http.post('*/api/social/onboarding/complete', () => {
            overrides?.onComplete?.()
            return HttpResponse.json({ onboarded_at: new Date().toISOString(), followed: [] })
        }),
    )
}

async function reachReview(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Salsa' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Europe' }))
    expect(await screen.findByText('Editing Europe')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: /Not now/i }))
    expect(await screen.findByText("You're all set!")).toBeInTheDocument()
}

describe('OnboardingWizard', () => {
    it('shows More styles as the fifth pill and expands remaining styles inline', async () => {
        useBaseHandlers()
        const user = userEvent.setup()
        renderWizard()
        expect(await screen.findByRole('button', { name: 'Salsa' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '+ More styles' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Mambo (On2)' })).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: '+ More styles' }))
        expect(screen.getByRole('button', { name: 'Mambo (On2)' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Cha-Cha' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '+ More styles' })).not.toBeInTheDocument()
    })

    it('requires a dance style and does not complete onboarding while advancing', async () => {
        let completed = false
        useBaseHandlers({ onComplete: () => { completed = true } })
        const user = userEvent.setup()
        renderWizard()
        expect(await screen.findByText('What do you dance?')).toBeInTheDocument()
        const continueButton = screen.getByRole('button', { name: 'Continue' })
        expect(continueButton).toBeDisabled()
        await user.click(screen.getByRole('button', { name: 'Salsa' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled())
        await user.click(screen.getByRole('button', { name: 'Continue' }))
        expect(await screen.findByText('Where do you want to discover events?')).toBeInTheDocument()
        expect(completed).toBe(false)
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
    })

    it('opens a preset in step 2 and progressively reveals near-home controls', async () => {
        useBaseHandlers()
        const user = userEvent.setup()
        renderWizard()
        await user.click(await screen.findByRole('button', { name: 'Salsa' }))
        await user.click(screen.getByRole('button', { name: 'Continue' }))
        await user.click(await screen.findByRole('button', { name: 'Europe' }))
        expect(await screen.findByText('Editing Europe')).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
        await user.click(screen.getByRole('button', { name: 'Continue' }))
        expect(await screen.findByText('Find events near home?')).toBeInTheDocument()
        expect(screen.queryByLabelText('City')).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Yes, find events near home/i }))
        expect(await screen.findByLabelText('City')).toBeInTheDocument()
        expect(screen.queryByText('Distance')).not.toBeInTheDocument()
        await user.click(await screen.findByRole('button', { name: 'Paris' }))
        expect(await screen.findByText('Distance')).toBeInTheDocument()
        expect(screen.getByText('25 km')).toBeInTheDocument()
    })

    it('opens the shared editor with the exact Custom name', async () => {
        useBaseHandlers()
        const user = userEvent.setup()
        renderWizard()
        await user.click(await screen.findByRole('button', { name: 'Salsa' }))
        await user.click(screen.getByRole('button', { name: 'Continue' }))
        await user.click(await screen.findByRole('button', { name: 'Custom' }))
        expect(await screen.findByText('Editing Custom')).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
    })

    it('returns review edits directly and persists only on Start exploring', async () => {
        let completed = false
        const created: Record<string, unknown>[] = []
        useBaseHandlers({ onComplete: () => { completed = true }, onCreate: (body) => created.push(body) })
        const user = userEvent.setup()
        renderWizard()
        await reachReview(user)
        expect(completed).toBe(false)
        await user.click(screen.getByRole('button', { name: /Dance styles/i }))
        expect(await screen.findByText('What do you dance?')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Bachata' }))
        await user.click(screen.getByRole('button', { name: 'Save' }))
        expect(await screen.findByText("You're all set!")).toBeInTheDocument()
        expect(screen.getByText('Salsa, Bachata')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Start exploring' }))
        await waitFor(() => expect(completed).toBe(true))
        expect(created).toHaveLength(1)
        expect(created[0]).toMatchObject({ area_label: 'Europe', dance_tag_ids: [10, 11], reach_filter: 'international', matches_enabled: true, is_active: true })
        expect(await screen.findByText('home page')).toBeInTheDocument()
    })
})
