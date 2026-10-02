import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import useBackToClose from './useBackToClose'

function Overlay({ name, onClose, refuse = false }: { name: string; onClose: () => void; refuse?: boolean }) {
    useBackToClose(refuse ? () => { } : onClose)
    return (
        <div>
            <p>{name}</p>
            <button onClick={onClose}>close {name}</button>
        </div>
    )
}

function Harness({ refuse = false }: { refuse?: boolean }) {
    const [outer, setOuter] = useState(false)
    const [inner, setInner] = useState(false)
    return (
        <div>
            <button onClick={() => setOuter(true)}>open outer</button>
            <button onClick={() => setInner(true)}>open inner</button>
            {outer && <Overlay name="outer" onClose={() => setOuter(false)} refuse={refuse} />}
            {inner && <Overlay name="inner" onClose={() => setInner(false)} />}
        </div>
    )
}

const back = () => act(async () => {
    window.history.back()
    await new Promise((r) => setTimeout(r, 20))
})

describe('useBackToClose', () => {
    it('Back closes the top overlay first, then the next, without leaving the page', async () => {
        const startLength = window.history.length
        const { unmount } = render(<Harness />)
        fireEvent.click(screen.getByText('open outer'))
        fireEvent.click(screen.getByText('open inner'))
        await waitFor(() => expect(window.history.length).toBe(startLength + 2))

        await back()
        await waitFor(() => expect(screen.queryByText('inner')).not.toBeInTheDocument())
        expect(screen.getByText('outer')).toBeInTheDocument()

        await back()
        await waitFor(() => expect(screen.queryByText('outer')).not.toBeInTheDocument())
        unmount()
    })

    it('Back does not push a history entry when the overlay closes', async () => {
        const { unmount } = render(<Harness />)
        fireEvent.click(screen.getByText('open outer'))
        await waitFor(() => expect((window.history.state as { __overlay?: number })?.__overlay).toBeDefined())

        // Gesture-less pushes make Chrome's back button skip the page entry.
        const pushSpy = vi.spyOn(window.history, 'pushState')
        await back()
        await waitFor(() => expect(screen.queryByText('outer')).not.toBeInTheDocument())
        expect(pushSpy).not.toHaveBeenCalled()
        unmount()
    })

    it('closing via the UI unwinds its history entry', async () => {
        const { unmount } = render(<Harness />)
        fireEvent.click(screen.getByText('open outer'))
        await waitFor(() => expect((window.history.state as { __overlay?: number })?.__overlay).toBeDefined())

        fireEvent.click(screen.getByText('close outer'))
        await waitFor(() => expect((window.history.state as { __overlay?: number } | null)?.__overlay).toBeUndefined())
        unmount()
    })

    it('keeps the overlay and its entry when the close is refused', async () => {
        const { unmount } = render(<Harness refuse />)
        fireEvent.click(screen.getByText('open outer'))
        await waitFor(() => expect((window.history.state as { __overlay?: number })?.__overlay).toBeDefined())

        await back()
        expect(screen.getByText('outer')).toBeInTheDocument()
        expect((window.history.state as { __overlay?: number })?.__overlay).toBeDefined()

        fireEvent.click(screen.getByText('close outer'))
        await waitFor(() => expect((window.history.state as { __overlay?: number } | null)?.__overlay).toBeUndefined())
        unmount()
    })

    it('keeps a URL replaced while the overlay was open after closing it', async () => {
        const { unmount } = render(<Harness />)
        fireEvent.click(screen.getByText('open outer'))
        await waitFor(() => expect((window.history.state as { __overlay?: number })?.__overlay).toBeDefined())

        window.history.replaceState({ usr: null }, '', '/browse?tag_ids=1')
        expect((window.history.state as { __overlay?: number }).__overlay).toBeDefined()

        await back()
        await waitFor(() => expect(screen.queryByText('outer')).not.toBeInTheDocument())
        await waitFor(() => expect((window.history.state as { __overlay?: number } | null)?.__overlay).toBeUndefined())
        expect(window.location.pathname + window.location.search).toBe('/browse?tag_ids=1')
        unmount()
    })
})
