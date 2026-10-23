import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { useNotificationOpenAttribution } from './useNotificationOpenAttribution'
import { trackNotificationOpen } from '../utils/tracking'

vi.mock('../utils/tracking', () => ({ trackNotificationOpen: vi.fn() }))

function Probe() {
    useNotificationOpenAttribution()
    const location = useLocation()
    return <p data-testid="url">{`${location.pathname}${location.search}${location.hash}`}</p>
}

function renderAt(url: string) {
    render(
        <MemoryRouter initialEntries={[url]}>
            <Routes>
                <Route path="*" element={<Probe />} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => vi.mocked(trackNotificationOpen).mockClear())

describe('useNotificationOpenAttribution', () => {
    it('reports the open and strips via/nid while keeping other params and the hash', async () => {
        renderAt('/notifications?kind=interest_event&via=push&nid=42#top')

        expect(await screen.findByText('/notifications?kind=interest_event#top')).toBeInTheDocument()
        expect(trackNotificationOpen).toHaveBeenCalledExactlyOnceWith(42, 'push', undefined)
    })

    it('passes the signed email token and strips it from the URL', async () => {
        renderAt('/event/e1?via=email&nid=7&t=7.sig')

        expect(await screen.findByText('/event/e1')).toBeInTheDocument()
        expect(trackNotificationOpen).toHaveBeenCalledExactlyOnceWith(7, 'email', '7.sig')
    })

    it('ignores unrelated query params', () => {
        renderAt('/event/e1?via=share&nid=1')

        expect(screen.getByTestId('url')).toHaveTextContent('/event/e1?via=share&nid=1')
        expect(trackNotificationOpen).not.toHaveBeenCalled()
    })
})
