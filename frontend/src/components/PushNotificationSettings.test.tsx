import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import PushNotificationSettings from './PushNotificationSettings'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

// usePush touches navigator.serviceWorker / Notification / PushManager, which
// are exercised directly in usePush.test.ts. Here we stub the hook so the
// settings component can be tested in isolation with a controllable push
// surface. The mocked module is reset to a sane default before each test.
const pushMock = {
  status: 'off' as
    | 'unsupported'
    | 'disabled'
    | 'denied'
    | 'off'
    | 'on',
  busy: false,
  error: null as string | null,
  enable: vi.fn(async () => {}),
  disable: vi.fn(async () => {}),
}

vi.mock('../hooks/usePush', () => ({
  usePush: () => pushMock,
}))

beforeEach(() => {
  pushMock.status = 'off'
  pushMock.busy = false
  pushMock.error = null
  pushMock.enable = vi.fn(async () => {})
  pushMock.disable = vi.fn(async () => {})
})

/** Mount with a signed-in user carrying the given preference overrides. */
function renderSignedIn(overrides: Partial<ReturnType<typeof makeUser>> = {}) {
  server.use(
    http.get('*/api/auth/me', () => HttpResponse.json(makeUser(overrides))),
  )
  return renderWithProviders(<PushNotificationSettings />)
}

describe('PushNotificationSettings', () => {
  it('hides the toggle when web-push is unsupported or disabled', async () => {
    pushMock.status = 'disabled'
    renderWithProviders(<PushNotificationSettings />)
    await waitFor(() =>
      expect(
        screen.queryByRole('switch', { name: /push notifications/i }),
      ).not.toBeInTheDocument(),
    )
  })

  it('renders for anonymous visitors (device-scoped, no sign-in required)', async () => {
    // Default /auth/me handler is a 401 (anonymous).
    renderWithProviders(<PushNotificationSettings />)
    const toggle = await screen.findByRole('switch', { name: /push notifications/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('enabling the toggle subscribes on the device without a signed-in user', async () => {
    const { user } = renderWithProviders(<PushNotificationSettings />)
    const toggle = await screen.findByRole('switch', { name: /push notifications/i })
    await user.click(toggle)

    await waitFor(() => expect(pushMock.enable).toHaveBeenCalledTimes(1))
  })

  it('enabling the toggle subscribes and flips the server flag when signed in', async () => {
    let patched: Record<string, unknown> | null = null
    server.use(
      http.patch('*/api/auth/notification-preferences', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          timezone: 'UTC',
          reminder_email_enabled: true,
          activity_email_enabled: true,
          push_enabled: true,
        })
      }),
    )

    const { user } = renderSignedIn()
    const toggle = await screen.findByRole('switch', { name: /push notifications/i })
    await user.click(toggle)

    await waitFor(() => expect(pushMock.enable).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(patched).toEqual({ push_enabled: true }))
  })

  it('shows the toggle disabled with a hint when permission is denied', async () => {
    pushMock.status = 'denied'
    renderWithProviders(<PushNotificationSettings />)
    const toggle = await screen.findByRole('switch', { name: /push notifications/i })
    expect(toggle).toBeDisabled()
    expect(screen.getByText(/blocked in your browser settings/i)).toBeInTheDocument()
  })
})
