import { useEffect } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router-dom'
import InstallPrompt from './InstallPrompt'
import { AuthProvider } from '../context/AuthContext'
import { PwaInstallProvider, usePwaInstall } from '../context/PwaInstallContext'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

// The install banner only renders once `consentResolved` is true (it's kept
// hidden while the cookie-consent modal's scroll-lock is active — see the
// comment on `consentResolved` in ConsentContext). The real provider pulls in
// vanilla-cookieconsent + a live app-info fetch, so stub the hook instead.
vi.mock('../context/ConsentContext', () => ({
  useConsent: () => ({ consentResolved: true }),
}))

const SNOOZE_KEY = 'movida:install-snooze-until'
const PUSH_SNOOZE_KEY = 'movida:push-optin-snooze-until'
const DEFAULT_USER_AGENT = navigator.userAgent
const DEFAULT_PLATFORM = navigator.platform
const DEFAULT_MAX_TOUCH_POINTS = navigator.maxTouchPoints

// The install banner is only offered to signed-in users (anonymous visitors
// are prompted to sign in elsewhere first), so every test needs `/auth/me`
// to resolve to a user before the banner can appear.
function renderPrompt(userOverrides: Parameters<typeof makeUser>[0] = {}) {
  server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser(userOverrides))))
  return render(
    <MemoryRouter>
      <AuthProvider>
        <PwaInstallProvider>
          <InstallPrompt />
        </PwaInstallProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

function ProgramInvitationPrompt() {
  const { requestInstallInvitation } = usePwaInstall()
  useEffect(() => {
    requestInstallInvitation({ source: 'program', eventId: 'movida-2026', eventTitle: 'Movida 2026' })
  }, [requestInstallInvitation])
  return <InstallPrompt />
}

function renderProgramPrompt(userOverrides: Parameters<typeof makeUser>[0] = {}) {
  server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser(userOverrides))))
  return render(
    <MemoryRouter>
      <AuthProvider>
        <PwaInstallProvider>
          <ProgramInvitationPrompt />
        </PwaInstallProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

class FakeBeforeInstallPromptEvent extends Event {
  prompt: ReturnType<typeof vi.fn>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>

  constructor(outcome: 'accepted' | 'dismissed' = 'accepted') {
    super('beforeinstallprompt', { cancelable: true })
    this.prompt = vi.fn(async () => { })
    this.userChoice = Promise.resolve({ outcome })
  }
}

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: DEFAULT_USER_AGENT })
  Object.defineProperty(navigator, 'platform', { configurable: true, value: DEFAULT_PLATFORM })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: DEFAULT_MAX_TOUCH_POINTS })
  server.use(http.post('*/api/auth/me/installed', () => new HttpResponse(null, { status: 204 })))
  // Default to non-standalone mode for tests.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('InstallPrompt', () => {
  it('shows after beforeinstallprompt and hides when dismissed', async () => {
    const user = userEvent.setup()
    renderPrompt()

    const ev = new FakeBeforeInstallPromptEvent('dismissed')
    let prevented = false
    await act(async () => {
      prevented = !window.dispatchEvent(ev)
    })
    expect(prevented).toBe(true)

    expect(await screen.findByText(/install movida/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /not now/i }))

    await waitFor(() =>
      expect(screen.queryByText(/install movida/i)).not.toBeInTheDocument(),
    )
    expect(Number(localStorage.getItem(SNOOZE_KEY))).toBeGreaterThan(Date.now())
  })

  it('replays deferred prompt on install and remembers the choice', async () => {
    const user = userEvent.setup()
    renderPrompt()

    const ev = new FakeBeforeInstallPromptEvent('accepted')
    await act(async () => {
      window.dispatchEvent(ev)
    })

    const install = await screen.findByRole('button', { name: /install/i })
    await user.click(install)

    expect(ev.prompt).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByText(/install movida/i)).not.toBeInTheDocument(),
    )
  })

  it('does not show when recently snoozed', async () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 24 * 60 * 60 * 1000))
    renderPrompt()

    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(screen.queryByText(/install movida/i)).not.toBeInTheDocument()
  })

  it('shows again once the snooze window has expired', async () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() - 1000))
    renderPrompt()

    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(await screen.findByText(/install movida/i)).toBeInTheDocument()
  })

  it('does not show in standalone display mode', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(display-mode: standalone)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    renderPrompt()
    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(screen.queryByText(/install movida/i)).not.toBeInTheDocument()
  })

  it('hides "Not now" on the install banner when force_install_prompt is true', async () => {
    // Snoozed, so without the force override the banner would stay hidden.
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 24 * 60 * 60 * 1000))
    renderPrompt({ force_install_prompt: true })

    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(await screen.findByText(/install movida/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /not now/i })).not.toBeInTheDocument()
  })

  it('stays hidden on onboarding routes', async () => {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser())))
    render(
      <MemoryRouter initialEntries={['/onboarding/preferences']}>
        <AuthProvider>
          <PwaInstallProvider>
            <InstallPrompt />
          </PwaInstallProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(screen.queryByText(/install movida/i)).not.toBeInTheDocument()
  })

  it('stays hidden while the user still needs onboarding', async () => {
    renderPrompt({ needs_onboarding: true, onboarded_at: null })

    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(screen.queryByText(/install movida/i)).not.toBeInTheDocument()
  })

  it('uses My Plan copy for a contextual invitation without replacing global eligibility', async () => {
    renderProgramPrompt()

    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(await screen.findByText('Keep your plan up to date')).toBeInTheDocument()
    expect(screen.getByText(/sessions in My Plan change or are cancelled/i)).toBeInTheDocument()
  })

  it('shows a My Plan invitation despite the default snooze and records contextual dismissal', async () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 24 * 60 * 60 * 1000))
    renderProgramPrompt()

    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(await screen.findByText('Keep your plan up to date')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /not now/i }))

    expect(localStorage.getItem('movida:program-install-dismissed:user-1:movida-2026')).toBe('1')
  })

  it('records contextual dismissal when the native install prompt is dismissed', async () => {
    renderProgramPrompt()
    const ev = new FakeBeforeInstallPromptEvent('dismissed')

    await act(async () => {
      window.dispatchEvent(ev)
    })
    await userEvent.click(await screen.findByRole('button', { name: /install app/i }))

    expect(ev.prompt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('movida:program-install-dismissed:user-1:movida-2026')).toBe('1')
  })

  it('offers manual Add to Home Screen guidance on iPhone', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    })
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' })
    renderPrompt()

    expect(await screen.findByText('Install Movida')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'How to install' }))

    expect(screen.getByRole('dialog', { name: 'Install Movida' })).toBeInTheDocument()
    expect(screen.getByText('2. Add to Home Screen')).toBeInTheDocument()
  })

  describe('push opt-in force override', () => {
    afterEach(() => {
      for (const key of ['PushManager', 'Notification'] as const) {
        if (key in globalThis) {
          delete (globalThis as Record<string, unknown>)[key]
        }
      }
      if ('serviceWorker' in navigator) {
        delete (navigator as unknown as Record<string, unknown>).serviceWorker
      }
    })

    it('shows the enable-notifications banner despite the snooze when force_enable_push_prompt is true', async () => {
      // Snoozed, so without the force override the banner would stay hidden.
      localStorage.setItem(PUSH_SNOOZE_KEY, String(Date.now() + 24 * 60 * 60 * 1000))

      // Standalone mode satisfies the "(justInstalled || isStandalone)" gate.
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: query === '(display-mode: standalone)',
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      })

      // usePush needs a VAPID key + PushManager/Notification support to
      // settle on 'off' rather than 'disabled'/'unsupported'.
      server.use(
        http.get('*/api/push/vapid-public-key', () =>
          HttpResponse.json({ public_key: 'dGVzdGtleQ' }),
        ),
      )
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: vi.fn(async () => null),
              subscribe: vi.fn(async () => ({})),
            },
          }),
        },
      })
      Object.defineProperty(globalThis, 'PushManager', {
        configurable: true,
        value: function PushManager() { },
      })
      Object.defineProperty(globalThis, 'Notification', {
        configurable: true,
        value: { permission: 'default', requestPermission: vi.fn(async () => 'granted') },
      })

      renderPrompt({ force_enable_push_prompt: true })

      expect(await screen.findByRole('region', { name: 'Stay in the loop!' })).toBeInTheDocument()
    })

    it('enables program push updates after a contextual notification opt-in', async () => {
      let patched: Record<string, unknown> | null = null
      const pendingProgramKey = 'movida:program-push-optin-pending:user-1'
      localStorage.setItem(pendingProgramKey, 'movida-2026')
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: query === '(display-mode: standalone)',
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      })
      server.use(
        http.get('*/api/push/vapid-public-key', () => HttpResponse.json({ public_key: 'dGVzdGtleQ' })),
        http.patch('*/api/auth/notification-preferences', async ({ request }) => {
          patched = await request.json() as Record<string, unknown>
          return HttpResponse.json({})
        }),
      )
      const subscription = {
        endpoint: 'https://push.example/subscription',
        toJSON: () => ({ keys: { p256dh: 'key', auth: 'auth' } }),
      }
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: vi.fn(async () => null),
              subscribe: vi.fn(async () => subscription),
            },
          }),
        },
      })
      Object.defineProperty(globalThis, 'PushManager', {
        configurable: true,
        value: function PushManager() { },
      })
      Object.defineProperty(globalThis, 'Notification', {
        configurable: true,
        value: { permission: 'default', requestPermission: vi.fn(async () => 'granted') },
      })

      renderPrompt({ push_schedule_updates_enabled: false })
      const enable = await screen.findByRole('button', { name: 'Turn on notifications' })
      await userEvent.click(enable)

      await waitFor(() => expect(patched).toEqual({ push_schedule_updates_enabled: true }))
      expect(localStorage.getItem(pendingProgramKey)).toBeNull()
      expect(screen.queryByText('Turn on program updates')).not.toBeInTheDocument()
    })
  })
})
