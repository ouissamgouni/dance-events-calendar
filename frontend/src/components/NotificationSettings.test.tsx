import { describe, expect, it } from 'vitest'
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

describe('NotificationSettings', () => {
  it('renders nothing while anonymous', async () => {
    // Default /auth/me handler is a 401 (anonymous).
    const { container } = renderWithProviders(<NotificationSettings />)
    // Give AuthContext a tick to settle on null.
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('reflects the user\u2019s saved email toggles', async () => {
    renderSignedIn({ reminder_email_enabled: true, activity_email_enabled: false })

    const reminder = await screen.findByRole('switch', { name: /event reminders/i })
    const activity = await screen.findByRole('switch', { name: /activity emails/i })
    expect(reminder).toHaveAttribute('aria-checked', 'true')
    expect(activity).toHaveAttribute('aria-checked', 'false')
  })

  it('PATCHes the toggled email category and refreshes the user', async () => {
    let patched: Record<string, unknown> | null = null
    server.use(
      http.patch('*/api/auth/notification-preferences', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          timezone: 'UTC',
          reminder_email_enabled: false,
          activity_email_enabled: true,
          push_enabled: false,
        })
      }),
      // After the optimistic write the component re-fetches /auth/me; return
      // the new state so the toggle settles in its updated position.
      http.get('*/api/auth/me', () =>
        HttpResponse.json(makeUser({ reminder_email_enabled: false })),
      ),
    )

    const { user } = renderSignedIn({ reminder_email_enabled: true })
    const reminder = await screen.findByRole('switch', { name: /event reminders/i })
    await user.click(reminder)

    await waitFor(() => expect(patched).toEqual({ reminder_email_enabled: false }))
  })

  it('surfaces an error when the preference write fails', async () => {
    server.use(
      http.patch('*/api/auth/notification-preferences', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    const { user } = renderSignedIn({ activity_email_enabled: true })
    const activity = await screen.findByRole('switch', { name: /activity emails/i })
    await user.click(activity)

    await waitFor(() =>
      expect(screen.getByText(/failed to update|failed to save/i)).toBeInTheDocument(),
    )
  })

  it('offers a one-click correction when the browser timezone differs', async () => {
    // The stored tz is a real zone (not "UTC") so the first-load auto-capture
    // never fires; the manual "use detected" button appears because the
    // detected browser zone differs from the stored one.
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const stored = detected === 'America/New_York' ? 'Europe/Paris' : 'America/New_York'

    let patched: Record<string, unknown> | null = null
    server.use(
      http.patch('*/api/auth/notification-preferences', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          timezone: detected,
          reminder_email_enabled: true,
          activity_email_enabled: true,
          push_enabled: false,
        })
      }),
    )

    const { user } = renderSignedIn({ timezone: stored })
    const btn = await screen.findByRole('button', { name: /use my detected timezone/i })
    await user.click(btn)

    await waitFor(() => expect(patched).toEqual({ timezone: detected }))
  })
})
