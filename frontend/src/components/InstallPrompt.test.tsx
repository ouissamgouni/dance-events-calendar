import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InstallPrompt from './InstallPrompt'

class FakeBeforeInstallPromptEvent extends Event {
  prompt: ReturnType<typeof vi.fn>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>

  constructor(outcome: 'accepted' | 'dismissed' = 'accepted') {
    super('beforeinstallprompt', { cancelable: true })
    this.prompt = vi.fn(async () => {})
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
    render(<InstallPrompt />)

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
    expect(localStorage.getItem('movida:install-dismissed')).toBe('1')
  })

  it('replays deferred prompt on install and remembers the choice', async () => {
    const user = userEvent.setup()
    render(<InstallPrompt />)

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
    expect(localStorage.getItem('movida:install-dismissed')).toBe('1')
  })

  it('does not show when already dismissed', async () => {
    localStorage.setItem('movida:install-dismissed', '1')
    render(<InstallPrompt />)

    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(screen.queryByText(/install movida/i)).not.toBeInTheDocument()
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

    render(<InstallPrompt />)
    await act(async () => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(screen.queryByText(/install movida/i)).not.toBeInTheDocument()
  })
})
