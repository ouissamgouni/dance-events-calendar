import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AdminBottomNav from './AdminBottomNav'

describe('AdminBottomNav', () => {
    it('marks the active tab, shows the Data badge and switches tabs', async () => {
        const onChange = vi.fn()
        render(<AdminBottomNav active="data" onChange={onChange} dataBadge={7} />)

        expect(screen.getByRole('button', { name: /Data/ })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByText('7')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: 'Users' }))
        expect(onChange).toHaveBeenCalledWith('users')
    })
})
