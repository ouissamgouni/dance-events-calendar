import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import NotificationsPanel from './NotificationsPanel'
import { server } from '../test/server'

const navigateMock = vi.fn()
const markReadMock = vi.fn(async () => { })
const markAllReadMock = vi.fn(async () => { })
const markSeenMock = vi.fn()
const refreshUnreadCountMock = vi.fn(async () => { })

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({
    markRead: markReadMock,
    markAllRead: markAllReadMock,
    markSeen: markSeenMock,
    refreshUnreadCount: refreshUnreadCountMock,
    unreadCount: 1,
    seen: false,
  }),
}))

beforeEach(() => {
  navigateMock.mockReset()
  markReadMock.mockClear()
  markAllReadMock.mockClear()
  markSeenMock.mockClear()
  refreshUnreadCountMock.mockClear()
})

describe('NotificationsPanel (event reminders)', () => {
  it('renders the reminder row copy and routes to the event on click', async () => {
    server.use(
      http.get('*/api/notifications', () =>
        HttpResponse.json({
          items: [
            {
              id: 42,
              kind: 'event_reminder',
              event_id: 'ev-remind',
              event_title: 'Rooftop Salsa Social',
              event_start: '2026-07-01T20:00:00Z',
              actor: {
                handle: 'alice',
                display_name: 'Alice',
                avatar_url: null,
                is_verified_organizer: false,
              },
              created_at: '2026-06-25T10:00:00Z',
              read_at: null,
            },
          ],
          total: 1,
          unread_count: 1,
          limit: 20,
          offset: 0,
        }),
      ),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <MemoryRouter>
        <NotificationsPanel open onClose={onClose} />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/reminder/i)).toBeInTheDocument()
    expect(screen.getByText(/rooftop salsa social/i)).toBeInTheDocument()
    expect(screen.getByText(/^starts /i)).toBeInTheDocument()

    // Opening the panel already marked the row read (view = read), so
    // clicking it just navigates — markRead is a no-op for already-read rows.
    await waitFor(() => expect(markAllReadMock).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: /reminder/i }))

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/event/ev-remind'))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders the promo code added row copy and routes to the event on click', async () => {
    server.use(
      http.get('*/api/notifications', () =>
        HttpResponse.json({
          items: [
            {
              id: 43,
              kind: 'promo_code_added',
              event_id: 'ev-promo',
              event_title: 'Rooftop Salsa Social',
              event_start: null,
              context: 'SAVE10',
              actor: {
                handle: 'alice',
                display_name: 'Alice',
                avatar_url: null,
                is_verified_organizer: false,
              },
              created_at: '2026-06-25T10:00:00Z',
              read_at: null,
            },
          ],
          total: 1,
          unread_count: 1,
          limit: 20,
          offset: 0,
        }),
      ),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <MemoryRouter>
        <NotificationsPanel open onClose={onClose} />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/promo code added/i)).toBeInTheDocument()
    expect(screen.getByText(/rooftop salsa social/i)).toBeInTheDocument()
    expect(screen.getByText(/code: save10/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /promo code added/i }))

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/event/ev-promo'))
    expect(onClose).toHaveBeenCalled()
  })

  it('marks everything read as soon as the panel opens (view = read)', async () => {
    server.use(
      http.get('*/api/notifications', () =>
        HttpResponse.json({
          items: [
            {
              id: 7,
              kind: 'new_follower',
              event_id: null,
              event_title: null,
              event_start: null,
              actor: {
                handle: 'bob',
                display_name: 'Bob',
                avatar_url: null,
                is_verified_organizer: false,
              },
              created_at: '2026-06-25T10:00:00Z',
              read_at: null,
            },
          ],
          total: 1,
          unread_count: 1,
          limit: 20,
          offset: 0,
        }),
      ),
    )

    render(
      <MemoryRouter>
        <NotificationsPanel open onClose={vi.fn()} />
      </MemoryRouter>,
    )

    await waitFor(() => expect(markAllReadMock).toHaveBeenCalled())
    expect(markSeenMock).toHaveBeenCalled()
  })
})
