import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import NotificationSettings from './NotificationSettings'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

/** Mount with a signed-in user carrying the given preference overrides. */
function renderSignedIn(overrides: Partial<ReturnType<typeof makeUser>> = {}) {
  server.use(
    http.get('*/api/auth/me', () => HttpResponse.json(makeUser(overrides))),
  )
  return renderWithProviders(<NotificationSettings />)
}

// Web-push capability is detected by presence of serviceWorker/PushManager/
// Notification. The jsdom environment ships with Notification but not the
// other two, so tests that want the Push column must stub them.
function stubWebPushCapable() {
  const originalSw = 'serviceWorker' in navigator
  const originalPm = 'PushManager' in window
  const originalNo = 'Notification' in window
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {},
    configurable: true,
    writable: true,
  })
  Object.defineProperty(window, 'PushManager', {
    value: function () {},
    configurable: true,
    writable: true,
  })
  Object.defineProperty(window, 'Notification', {
    value: function () {},
    configurable: true,
    writable: true,
  })
  return () => {
    if (!originalSw) delete (navigator as unknown as Record<string, unknown>).serviceWorker
    if (!originalPm) delete (window as unknown as Record<string, unknown>).PushManager
    if (!originalNo) delete (window as unknown as Record<string, unknown>).Notification
  }
}

describe('NotificationSettings', () => {
  let restorePush: (() => void) | null = null
  beforeEach(() => {
    restorePush = stubWebPushCapable()
  })
  afterEach(() => {
    restorePush?.()
    restorePush = null
    vi.restoreAllMocks()
  })

  it('renders nothing while anonymous', async () => {
    const { container } = renderWithProviders(<NotificationSettings />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('renders the 3x2 feature x channel matrix', async () => {
    renderSignedIn()
    // Six switches: three features x two channels.
    for (const feature of ['Event reminders', 'Friends & social', 'Interest matches']) {
      expect(
        await screen.findByRole('switch', { name: `${feature} \u2014 email` }),
      ).toBeInTheDocument()
      expect(
        await screen.findByRole('switch', { name: `${feature} \u2014 push` }),
      ).toBeInTheDocument()
    }
  })

  it('reflects saved flag values per cell', async () => {
    renderSignedIn({
      email_event_reminders_enabled: true,
      email_social_activity_enabled: false,
      push_interest_matches_enabled: false,
    })
    expect(
      await screen.findByRole('switch', { name: 'Event reminders \u2014 email' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      await screen.findByRole('switch', { name: 'Friends & social \u2014 email' }),
    ).toHaveAttribute('aria-checked', 'false')
    expect(
      await screen.findByRole('switch', { name: 'Interest matches \u2014 push' }),
    ).toHaveAttribute('aria-checked', 'false')
  })

  it('PATCHes the specific new flag when a cell is toggled', async () => {
    let patched: Record<string, unknown> | null = null
    server.use(
      http.patch('*/api/auth/notification-preferences', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({})
      }),
    )
    const { user } = renderSignedIn({ email_event_reminders_enabled: true })
    const cell = await screen.findByRole('switch', {
      name: 'Event reminders \u2014 email',
    })
    await user.click(cell)
    await waitFor(() =>
      expect(patched).toEqual({ email_event_reminders_enabled: false }),
    )
  })

  it('pauses every channel with a single PATCH', async () => {
    let patched: Record<string, unknown> | null = null
    server.use(
      http.patch('*/api/auth/notification-preferences', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({})
      }),
    )
    const { user } = renderSignedIn()
    const btn = await screen.findByRole('button', { name: /pause all notifications/i })
    await user.click(btn)
    await waitFor(() =>
      expect(patched).toEqual({
        email_event_reminders_enabled: false,
        push_event_reminders_enabled: false,
        email_social_activity_enabled: false,
        push_social_activity_enabled: false,
        email_interest_matches_enabled: false,
        push_interest_matches_enabled: false,
      }),
    )
  })

  it('hides the Push column when the browser cannot do web push', async () => {
    // Undo the beforeEach stubbing so PushManager/serviceWorker are absent.
    restorePush?.()
    restorePush = null
    renderSignedIn()
    // Email cells still render.
    expect(
      await screen.findByRole('switch', { name: 'Event reminders \u2014 email' }),
    ).toBeInTheDocument()
    // Push cells are absent.
    expect(
      screen.queryByRole('switch', { name: 'Event reminders \u2014 push' }),
    ).not.toBeInTheDocument()
  })

  it('surfaces an error when the preference write fails', async () => {
    server.use(
      http.patch('*/api/auth/notification-preferences', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )
    const { user } = renderSignedIn()
    const cell = await screen.findByRole('switch', {
      name: 'Friends & social \u2014 email',
    })
    await user.click(cell)
    await waitFor(() =>
      expect(screen.getByText(/failed to (save|update)/i)).toBeInTheDocument(),
    )
  })

  it('offers a one-click correction when the browser timezone differs', async () => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const stored = detected === 'America/New_York' ? 'Europe/Paris' : 'America/New_York'
    let patched: Record<string, unknown> | null = null
    server.use(
      http.patch('*/api/auth/notification-preferences', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({})
      }),
    )
    const { user } = renderSignedIn({ timezone: stored })
    const btn = await screen.findByRole('button', { name: /use my detected timezone/i })
    await user.click(btn)
    await waitFor(() => expect(patched).toEqual({ timezone: detected }))
  })
})
