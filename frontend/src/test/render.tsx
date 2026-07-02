import type { ReactElement, ReactNode } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { AuthProvider } from '../context/AuthContext'
import { AttendanceSummariesProvider } from '../context/AttendanceSummariesContext'
import { SavedEventsProvider } from '../context/SavedEventsContext'
import { AttendingEventsProvider } from '../context/AttendingEventsContext'

interface ProvidersProps {
    children: ReactNode
    /** Initial router entries; defaults to a single "/" entry. */
    routerEntries?: string[]
}

/**
 * The provider subset needed by the event-interaction surface (RSVP / save
 * buttons and the contexts they read). Ordering mirrors App.tsx: Auth wraps
 * everything, AttendanceSummaries supplies the cache invalidation hook that
 * Saved/Attending depend on. Heavier admin/rating/notification providers are
 * intentionally excluded — pull them in per-test only where a component
 * actually requires them.
 */
function Providers({ children, routerEntries = ['/'] }: ProvidersProps) {
    return (
        <MemoryRouter initialEntries={routerEntries}>
            <AuthProvider>
                <AttendanceSummariesProvider>
                    <SavedEventsProvider>
                        <AttendingEventsProvider>{children}</AttendingEventsProvider>
                    </SavedEventsProvider>
                </AttendanceSummariesProvider>
            </AuthProvider>
        </MemoryRouter>
    )
}

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
    routerEntries?: string[]
}

/**
 * Render `ui` inside the event-interaction provider tree and return the
 * usual Testing Library result plus a pre-bound `user` event helper.
 */
export function renderWithProviders(
    ui: ReactElement,
    { routerEntries, ...options }: RenderWithProvidersOptions = {},
) {
    return {
        user: userEvent.setup(),
        ...render(ui, {
            wrapper: ({ children }) => <Providers routerEntries={routerEntries}>{children}</Providers>,
            ...options,
        }),
    }
}

export { userEvent }
