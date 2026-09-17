import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EventImageEditor from './EventImageEditor'
import * as api from '../api'
import type { CalendarEvent } from '../types'

vi.mock('../api', () => ({
    uploadEventImage: vi.fn(),
    setEventImageFromUrl: vi.fn(),
    deleteEventImage: vi.fn(),
}))

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        event_id: 'evt-1',
        calendar_id: 'cal-1',
        title: 'Salsa Social',
        description: null,
        location: null,
        latitude: null,
        longitude: null,
        start: new Date().toISOString(),
        end: new Date().toISOString(),
        all_day: false,
        color: '#000',
        ...overrides,
    } as CalendarEvent
}

describe('EventImageEditor', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('shows the empty state and hides Remove when there is no picture', () => {
        render(<EventImageEditor event={makeEvent()} onChange={vi.fn()} />)

        expect(screen.getByTestId('event-image-empty')).toBeInTheDocument()
        expect(screen.queryByTestId('event-image-remove')).not.toBeInTheDocument()
    })

    it('prefers the thumb variant for the preview', () => {
        render(
            <EventImageEditor
                event={makeEvent({
                    image_url: 'https://cdn.test/full.webp',
                    image_thumb_url: 'https://cdn.test/thumb.webp',
                })}
                onChange={vi.fn()}
            />,
        )

        expect(screen.getByTestId('event-image-preview')).toHaveAttribute(
            'src',
            'https://cdn.test/thumb.webp',
        )
    })

    it('uploads a selected file and reports the updated event', async () => {
        const updated = makeEvent({ image_thumb_url: 'https://cdn.test/new.webp' })
        vi.mocked(api.uploadEventImage).mockResolvedValue(updated)
        const onChange = vi.fn()
        render(<EventImageEditor event={makeEvent()} onChange={onChange} />)

        const file = new File(['x'], 'pic.png', { type: 'image/png' })
        await userEvent.upload(screen.getByTestId('event-image-file'), file)

        await waitFor(() => expect(onChange).toHaveBeenCalledWith(updated))
        expect(api.uploadEventImage).toHaveBeenCalledWith('evt-1', file)
    })

    it('surfaces an inline error when the upload is rejected', async () => {
        vi.mocked(api.uploadEventImage).mockRejectedValue(new Error('Unsupported image type'))
        const onChange = vi.fn()
        render(<EventImageEditor event={makeEvent()} onChange={onChange} />)

        // The file picker is restricted by `accept`, so an unusable file is
        // caught server-side rather than by the browser.
        await userEvent.upload(
            screen.getByTestId('event-image-file'),
            new File(['not really a png'], 'broken.png', { type: 'image/png' }),
        )

        expect(await screen.findByTestId('event-image-error')).toHaveTextContent(
            'Unsupported image type',
        )
        expect(onChange).not.toHaveBeenCalled()
    })

    it('imports from a URL and clears the field', async () => {
        const updated = makeEvent({ image_thumb_url: 'https://cdn.test/imported.webp' })
        vi.mocked(api.setEventImageFromUrl).mockResolvedValue(updated)
        const onChange = vi.fn()
        render(<EventImageEditor event={makeEvent()} onChange={onChange} />)

        const input = screen.getByTestId('event-image-url')
        await userEvent.type(input, 'https://example.com/a.jpg')
        await userEvent.click(screen.getByTestId('event-image-import'))

        await waitFor(() =>
            expect(api.setEventImageFromUrl).toHaveBeenCalledWith(
                'evt-1',
                'https://example.com/a.jpg',
            ),
        )
        expect(onChange).toHaveBeenCalledWith(updated)
        expect(input).toHaveValue('')
    })

    it('disables Import while the URL field is empty', () => {
        render(<EventImageEditor event={makeEvent()} onChange={vi.fn()} />)

        expect(screen.getByTestId('event-image-import')).toBeDisabled()
    })

    it('removes an existing picture', async () => {
        const updated = makeEvent()
        vi.mocked(api.deleteEventImage).mockResolvedValue(updated)
        const onChange = vi.fn()
        render(
            <EventImageEditor
                event={makeEvent({ image_thumb_url: 'https://cdn.test/thumb.webp' })}
                onChange={onChange}
            />,
        )

        await userEvent.click(screen.getByTestId('event-image-remove'))

        await waitFor(() => expect(api.deleteEventImage).toHaveBeenCalledWith('evt-1'))
        expect(onChange).toHaveBeenCalledWith(updated)
    })
})
