import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'

const RECOVERY_FLAG = 'movida:error-recovery-attempted'

function Boom(): never {
    throw new Error('boom')
}

describe('ErrorBoundary', () => {
    beforeEach(() => {
        // Silence the expected error logs React/componentDidCatch emit.
        vi.spyOn(console, 'error').mockImplementation(() => { })
    })
    afterEach(() => {
        vi.restoreAllMocks()
        sessionStorage.clear()
    })

    it('renders children when nothing throws', () => {
        render(
            <ErrorBoundary>
                <p>all good</p>
            </ErrorBoundary>,
        )
        expect(screen.getByText('all good')).toBeInTheDocument()
    })

    it('shows the manual reload screen after a prior recovery attempt', () => {
        // Guard already set -> boundary skips the auto reload and renders the
        // manual fallback, so the test never triggers a jsdom reload.
        sessionStorage.setItem(RECOVERY_FLAG, '1')
        render(
            <ErrorBoundary>
                <Boom />
            </ErrorBoundary>,
        )
        expect(screen.getByText('Something went wrong')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    })
})
