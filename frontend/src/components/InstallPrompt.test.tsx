import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InstallPrompt from './InstallPrompt'
import { AuthProvider } from '../context/AuthContext'
import { PwaInstallProvider } from '../context/PwaInstallContext'

const SNOOZE_KEY = 'movida:install-snooze-until'

// The install banner itself (tested here) doesn't depend on auth state —
// only the post-install push opt-in toast is gated to signed-in users (see
// PushNotificationSettings/usePush tests for that behavior) — but
// InstallPrompt now reads useAuth() unconditionally, so AuthProvider must be
// present or the hook throws.
function renderPrompt() {
  return render(
    <AuthProvider>
      <PwaInstallProvider>
        <InstallPrompt />
      </PwaInstallProvider>
    </AuthProvider>,
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
})
