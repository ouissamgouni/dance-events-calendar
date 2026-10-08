import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FeatureDeliveryChannels from './AdminDeliveryChannels'

const on = { push: true, email_instant: true, email_digest: false }
const emailOff = { push: true, email_instant: false, email_digest: false }

describe('FeatureDeliveryChannels', () => {
    it('reports the toggled channel for its feature', async () => {
        const onChange = vi.fn()
        render(<FeatureDeliveryChannels feature="ticket_prompt" label="Ticket prompt" config={on} onChange={onChange} />)

        await userEvent.click(screen.getByRole('checkbox', { name: 'Ticket prompt email digest' }))

        expect(onChange).toHaveBeenCalledWith('ticket_prompt', 'email_digest', true)
    })

    it('locks digest for time-sensitive features', () => {
        render(<FeatureDeliveryChannels feature="event_reminders" label="Event reminders" config={on} onChange={vi.fn()} />)

        expect(screen.getByRole('checkbox', { name: 'Event reminders email digest' })).toBeDisabled()
        expect(screen.getByRole('checkbox', { name: 'Event reminders email instant' })).toBeEnabled()
        expect(screen.queryByText('Email off')).not.toBeInTheDocument()
    })

    it('flags email off when both email boxes are unchecked', () => {
        render(<FeatureDeliveryChannels feature="memories_prompt" label="Memories prompt" config={emailOff} onChange={vi.fn()} />)

        expect(screen.getByText('Email off')).toBeInTheDocument()
        expect(screen.getByRole('checkbox', { name: 'Memories prompt email digest' })).toBeEnabled()
    })

    it('renders nothing without settings for the feature', () => {
        const { container } = render(
            <FeatureDeliveryChannels feature="promo_codes" label="Promo codes" config={undefined} onChange={vi.fn()} />,
        )

        expect(container).toBeEmptyDOMElement()
    })

    it('is not clickable inside a disabled fieldset (feature flag off)', () => {
        render(
            <fieldset disabled>
                <FeatureDeliveryChannels feature="promo_codes" label="Promo codes" config={on} onChange={vi.fn()} />
            </fieldset>,
        )

        expect(screen.getByRole('checkbox', { name: 'Promo codes push' })).toBeDisabled()
        expect(screen.getByRole('checkbox', { name: 'Promo codes email instant' })).toBeDisabled()
    })
})
