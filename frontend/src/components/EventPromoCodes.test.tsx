import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEventPromoCodes } from '../api';
import type { CalendarEvent, PromoCode } from '../types';
import { EventPromoCodes } from './EventPromoCodes';

vi.mock('../api', () => ({
    deleteEventPromoCode: vi.fn(),
    fetchEventPromoCodes: vi.fn(),
    submitEventPromoCode: vi.fn(),
    updateEventPromoCode: vi.fn(),
}));

const auth = vi.hoisted(() => ({
    user: null as { user_id: string } | null,
}));

vi.mock('../context/AuthContext', () => ({
    useAuth: () => auth,
}));

vi.mock('../context/FeatureFlagsContext', () => ({
    useFeatureFlags: () => ({ promoCodesEnabled: true }),
}));

vi.mock('./EventPromoCodeDialog', () => ({
    default: ({ promo }: { promo?: PromoCode }) => (
        <div role="dialog" aria-label={promo ? 'Edit promo code' : 'Add promo code'} />
    ),
}));

const event: CalendarEvent = {
    event_id: 'event-1',
    calendar_id: 'calendar-1',
    title: 'Friday social',
    description: null,
    location: 'Paris, France',
    latitude: null,
    longitude: null,
    start: '2026-09-25T20:00:00Z',
    end: '2026-09-25T23:00:00Z',
    all_day: false,
    color: null,
    view_count: 0,
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: null,
    links: null,
    tags: [],
};

const promo: PromoCode = {
    id: 'promo-1',
    event_id: event.event_id,
    code: 'SALSAFRIDAY',
    description: '15% off pre-sale tickets',
    source_url: null,
    expires_at: null,
    status: 'approved',
    submitter: {
        user_id: 'submitter-1',
        handle: null,
        display_name: 'Dancer',
        avatar_url: null,
    },
    created_at: '2026-09-20T00:00:00Z',
    updated_at: '2026-09-20T00:00:00Z',
};

describe('EventPromoCodes rows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        auth.user = null;
        vi.mocked(fetchEventPromoCodes).mockResolvedValue([promo]);
    });

    it('presents each promo compactly and copies its code', async () => {
        const user = userEvent.setup();
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });

        render(<EventPromoCodes event={event} variant="rows" />);

        expect(await screen.findByRole('heading', { name: 'Promo codes' })).toBeInTheDocument();
        expect(screen.getByText('15% off pre-sale tickets')).toBeInTheDocument();
        expect(screen.getByText('SALSAFRIDAY')).toBeInTheDocument();
        expect(screen.getByText('No expiry')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Copy promo code SALSAFRIDAY' }));

        expect(writeText).toHaveBeenCalledWith('SALSAFRIDAY');
        expect(screen.getByRole('status')).toHaveTextContent('Copied "SALSAFRIDAY" to clipboard');
    });

    it('opens the shared edit sheet for the submitter', async () => {
        const user = userEvent.setup();
        auth.user = { user_id: promo.submitter.user_id };

        render(<EventPromoCodes event={event} variant="rows" />);

        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        expect(screen.getByRole('dialog', { name: 'Edit promo code' })).toBeInTheDocument();
    });

    it('shows an add action for an authenticated viewer when there are no codes', async () => {
        const user = userEvent.setup();
        auth.user = { user_id: 'viewer-1' };
        vi.mocked(fetchEventPromoCodes).mockResolvedValue([]);

        render(<EventPromoCodes event={event} variant="rows" />);

        await user.click(await screen.findByRole('button', { name: 'Add promo code' }));
        expect(screen.getByRole('dialog', { name: 'Add promo code' })).toBeInTheDocument();
    });

    it('hides the section from an anonymous viewer when there are no codes', async () => {
        vi.mocked(fetchEventPromoCodes).mockResolvedValue([]);

        render(<EventPromoCodes event={event} variant="rows" />);

        await waitFor(() => expect(fetchEventPromoCodes).toHaveBeenCalledWith(event.event_id));
        expect(screen.queryByTestId('promo-codes-section')).not.toBeInTheDocument();
    });
});
