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
import type { TagsPickerValue } from '../components/TagsPicker'
import type { TagGroup } from '../types'

// The wizard embeds a Leaflet map (react-leaflet + AreaMapPicker) that does not
// render under jsdom, plus the event-card and tag-picker surfaces. Stub them so
// the test drives the step flow deterministically. The TagsPicker stub renders
// one button per group that selects the group's first tag on click.
vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    TileLayer: () => null,
    CircleMarker: () => null,
    Rectangle: () => null,
    useMap: () => ({ fitBounds: vi.fn() }),
}))

vi.mock('../components/AreaMapPicker', () => ({
    default: () => <div data-testid="area-map-picker">area map picker</div>,
}))

vi.mock('../components/RailEventCard', () => ({
    default: () => <div data-testid="rail-event-card">event card</div>,
}))

vi.mock('../components/TagsPicker', () => ({
    default: ({
        tagGroups,
        onChange,
    }: {
        tagGroups: TagGroup[]
        onChange: (next: TagsPickerValue) => void
    }) => {
        const group = tagGroups[0]
        return (
            <button
                type="button"
                onClick={() =>
                    onChange({ selectedTagIds: group?.tags[0] ? [group.tags[0].id] : [], freeTexts: {} })
                }
            >
                pick-{group?.slug}
            </button>
        )
    },
}))

function makeTag(overrides: Partial<TagGroup['tags'][number]>): TagGroup['tags'][number] {
    return {
        id: 1,
        slug: 'salsa',
        label: 'Salsa',
        color: null,
        ordinal: 0,
        group_slug: 'dance-style',
        group_label: 'Dance styles',
        group_color: null,
        enabled: true,
        is_hero_filter: false,
        hero_ordinal: null,
        ...overrides,
    }
}

function makeGroup(overrides: Partial<TagGroup>): TagGroup {
    return {
        id: 1,
        slug: 'dance-style',
        label: 'Dance styles',
        color: null,
        ordinal: 0,
        allow_multiple: true,
        enabled: true,
        onboarding_eligible: true,
        tags: [],
        ...overrides,
    }
}

const danceGroup = makeGroup({
    id: 1,
    slug: 'dance-style',
    label: 'Dance styles',
    tags: [makeTag({ id: 10, slug: 'salsa', label: 'Salsa' })],
})

const reachGroup = makeGroup({
    id: 2,
    slug: 'reach',
    label: 'Reach',
    tags: [
        makeTag({ id: 20, slug: 'international', label: 'International', group_slug: 'reach' }),
        makeTag({ id: 21, slug: 'local', label: 'Local', group_slug: 'reach' }),
    ],
})

function renderWizard() {
    return render(
        <MemoryRouter initialEntries={['/onboarding/preferences?next=/']}>
            <AuthProvider>
                <PreferencesProvider>
                    <AttendanceSummariesProvider>
                        <SavedEventsProvider>
                            <AttendingEventsProvider>
                                <Routes>
                                    <Route path="/onboarding/preferences" element={<OnboardingWizard />} />
                                    <Route path="/" element={<p>home page</p>} />
                                </Routes>
                            </AttendingEventsProvider>
                        </SavedEventsProvider>
                    </AttendanceSummariesProvider>
                </PreferencesProvider>
            </AuthProvider>
        </MemoryRouter>,
    )
}

describe('OnboardingWizard', () => {
    it('gates step 1 on style selection, then soft-completes onboarding and advances', async () => {
        let completeCalled = false
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(
                    makeUser({
                        needs_onboarding: true,
                        onboarded_at: null,
                        preferences: {
                            share_attendance_default: false,
                            preferred_area: null,
                            preferred_tag_ids: [],
                            home_location: null,
                            set_at: null,
                        },
                    }),
                ),
            ),
            http.get('*/api/tags', () => HttpResponse.json([danceGroup, reachGroup])),
            http.get('*/api/social/onboarding/suggestions', () => HttpResponse.json({ items: [] })),
            http.get('*/api/events/popular-cities', () => HttpResponse.json([])),
            http.get('*/api/auth/geolocate-ip', () => new HttpResponse(null, { status: 204 })),
            http.get('*/api/interest-profiles', () => HttpResponse.json([])),
            http.patch('*/api/auth/preferences', async ({ request }) => {
                const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
                return HttpResponse.json({
                    share_attendance_default: false,
                    preferred_area: (body.preferred_area as unknown) ?? null,
                    preferred_tag_ids: (body.preferred_tag_ids as number[]) ?? [],
                    home_location: (body.home_location as unknown) ?? null,
                    set_at: new Date().toISOString(),
                })
            }),
            http.post('*/api/social/onboarding/complete', () => {
                completeCalled = true
                return HttpResponse.json({ onboarded_at: new Date().toISOString(), followed: [] })
            }),
        )

        const user = userEvent.setup()
        renderWizard()

        // Step 1 renders once tag groups load.
        expect(await screen.findByText('What do you dance?')).toBeInTheDocument()

        const continueBtn = screen.getByRole('button', { name: /continue/i })
        expect(continueBtn).toBeDisabled()

        // Pick a dance style — Continue becomes enabled.
        await user.click(await screen.findByRole('button', { name: 'pick-dance-style' }))
        await waitFor(() => expect(continueBtn).toBeEnabled())

        // The live event preview now lives on its own step (step 3), so it is
        // not rendered on step 1.
        expect(screen.queryByText(/A taste of what you'll see/i)).not.toBeInTheDocument()

        // Advancing soft-completes onboarding and moves to step 2.
        await user.click(continueBtn)
        expect(await screen.findByText('Where do you dance?')).toBeInTheDocument()
        await waitFor(() => expect(completeCalled).toBe(true))
    })

    it('walks the 5 steps to the recap with no standalone preview step', async () => {
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(
                    makeUser({
                        needs_onboarding: false,
                        onboarded_at: new Date().toISOString(),
                        preferences: {
                            share_attendance_default: false,
                            preferred_area: null,
                            preferred_tag_ids: [],
                            home_location: null,
                            set_at: null,
                        },
                    }),
                ),
            ),
            http.get('*/api/tags', () => HttpResponse.json([danceGroup, reachGroup])),
            http.get('*/api/social/onboarding/suggestions', () =>
                HttpResponse.json({
                    items: [
                        {
                            handle: 'salsahub',
                            display_name: 'Salsa Hub',
                            avatar_url: null,
                            subscribers_count: 3,
                            is_followed_by_viewer: false,
                            is_friend: false,
                            is_verified_organizer: true,
                            is_admin_managed: false,
                            is_subscribed: false,
                        },
                    ],
                }),
            ),
            http.get('*/api/events', () => HttpResponse.json([])),
            http.get('*/api/events/popular-cities', () =>
                HttpResponse.json([{ city: 'Paris', country: 'France', latitude: 48.8566, longitude: 2.3522 }]),
            ),
            http.get('*/api/auth/geolocate-ip', () => new HttpResponse(null, { status: 204 })),
            http.get('*/api/interest-profiles', () => HttpResponse.json([])),
            http.post('*/api/interest-profiles', () => HttpResponse.json({ id: 1 })),
            http.patch('*/api/auth/preferences', () =>
                HttpResponse.json({
                    share_attendance_default: false,
                    preferred_area: null,
                    preferred_tag_ids: [],
                    home_location: null,
                    set_at: new Date().toISOString(),
                }),
            ),
            http.post('*/api/social/onboarding/complete', () =>
                HttpResponse.json({ onboarded_at: new Date().toISOString(), followed: [] }),
            ),
        )

        const user = userEvent.setup()
        renderWizard()

        // Step 1 → pick a style → step 2.
        expect(await screen.findByText('What do you dance?')).toBeInTheDocument()
        await user.click(await screen.findByRole('button', { name: 'pick-dance-style' }))
        await user.click(screen.getByRole('button', { name: /continue/i }))

        // Step 2 owns the preview: the worldwide map + an "In your area" trail
        // and the alert toggle. There is no standalone "preview" step.
        expect(await screen.findByText('Where do you dance?')).toBeInTheDocument()
        expect(screen.getByText('In your area')).toBeInTheDocument()
        expect(screen.getByText(/Alert me about matches/i)).toBeInTheDocument()

        // Step 3 (follow).
        await user.click(screen.getByRole('button', { name: /continue/i }))
        expect(await screen.findByText('Build your tribe')).toBeInTheDocument()

        // Step 4 (local): Skip is the PRIMARY action.
        await user.click(screen.getByRole('button', { name: /continue/i }))
        expect(await screen.findByText('A closer look near home?')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /skip for now/i })).toBeInTheDocument()

        // Skipping the optional local profile reaches the recap.
        await user.click(screen.getByRole('button', { name: /skip for now/i }))
        expect(await screen.findByText("You're all set")).toBeInTheDocument()
        expect(screen.getByText('Default search profile')).toBeInTheDocument()
        expect(screen.getByText('Local search profile')).toBeInTheDocument()
        expect(screen.getByText('Following')).toBeInTheDocument()
    })

    it('deletes a previously-saved local profile when the local step is skipped', async () => {
        const deletedIds: number[] = []
        let clearedHome = false
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(
                    makeUser({
                        needs_onboarding: false,
                        onboarded_at: new Date().toISOString(),
                        preferences: {
                            share_attendance_default: false,
                            preferred_area: null,
                            preferred_tag_ids: [],
                            home_location: null,
                            set_at: null,
                        },
                    }),
                ),
            ),
            http.get('*/api/tags', () => HttpResponse.json([danceGroup, reachGroup])),
            http.get('*/api/social/onboarding/suggestions', () => HttpResponse.json({ items: [] })),
            http.get('*/api/events', () => HttpResponse.json([])),
            http.get('*/api/events/popular-cities', () =>
                HttpResponse.json([{ city: 'Paris', country: 'France', latitude: 48.8566, longitude: 2.3522 }]),
            ),
            http.get('*/api/auth/geolocate-ip', () => new HttpResponse(null, { status: 204 })),
            http.get('*/api/interest-profiles', () => HttpResponse.json([])),
            http.post('*/api/interest-profiles', () => HttpResponse.json({ id: 42 })),
            http.delete('*/api/interest-profiles/:id', ({ params }) => {
                deletedIds.push(Number(params.id))
                return new HttpResponse(null, { status: 204 })
            }),
            http.patch('*/api/auth/preferences', async ({ request }) => {
                const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
                if ('home_location' in body && body.home_location === null) clearedHome = true
                return HttpResponse.json({
                    share_attendance_default: false,
                    preferred_area: (body.preferred_area as unknown) ?? null,
                    preferred_tag_ids: (body.preferred_tag_ids as number[]) ?? [],
                    home_location: (body.home_location as unknown) ?? null,
                    set_at: new Date().toISOString(),
                })
            }),
            http.post('*/api/social/onboarding/complete', () =>
                HttpResponse.json({ onboarded_at: new Date().toISOString(), followed: [] }),
            ),
        )

        const user = userEvent.setup()
        renderWizard()

        // Step 1 → step 2 → step 3 → step 4 (local).
        await user.click(await screen.findByRole('button', { name: 'pick-dance-style' }))
        await user.click(screen.getByRole('button', { name: /continue/i }))
        expect(await screen.findByText('Where do you dance?')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /continue/i }))
        expect(await screen.findByText('Build your tribe')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /continue/i }))
        expect(await screen.findByText('A closer look near home?')).toBeInTheDocument()

        // Pick the Paris pill, then save the local profile (id 42).
        await user.click(await screen.findByRole('button', { name: 'Paris' }))
        await user.click(await screen.findByRole('button', { name: /save this profile/i }))
        expect(await screen.findByText("You're all set")).toBeInTheDocument()

        // Back to the local step, then skip: the saved profile is deleted and
        // the home location cleared.
        await user.click(screen.getByRole('button', { name: /back/i }))
        expect(await screen.findByText('A closer look near home?')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /skip for now/i }))

        await waitFor(() => expect(deletedIds).toContain(42))
        expect(clearedHome).toBe(true)
    })
})
