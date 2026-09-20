import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { submitEventPromoCode, updateEventPromoCode } from '../api';
import { ToastProvider } from './Toast';
import EventPromoCodeDialog from './EventPromoCodeDialog';

vi.mock('../api', () => ({
    submitEventPromoCode: vi.fn(),
    updateEventPromoCode: vi.fn(),
}));

describe('EventPromoCodeDialog', () => {
    beforeEach(() => {
        vi.mocked(submitEventPromoCode).mockReset();
        vi.mocked(updateEventPromoCode).mockReset();
    });

    it('validates required fields and submits the shared promo form', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onSubmitted = vi.fn();
        vi.mocked(submitEventPromoCode).mockResolvedValue({
            id: 'promo-1',
            event_id: 'event-1',
            code: 'SALSA10',
            description: 'Ten percent off',
            source_url: 'https://example.com/deal',
            expires_at: null,
            status: 'pending',
            submitter: { user_id: 'user-1', handle: null, display_name: 'Dancer', avatar_url: null },
            created_at: '2026-09-20T00:00:00Z',
            updated_at: '2026-09-20T00:00:00Z',
        });

        render(
            <ToastProvider>
                <EventPromoCodeDialog
                    eventId="event-1"
                    onClose={onClose}
                    onSubmitted={onSubmitted}
                />
            </ToastProvider>,
        );

        await user.click(screen.getByRole('button', { name: 'Submit promo code' }));
        expect(screen.getByText('Promo code is required.')).toBeInTheDocument();
        expect(submitEventPromoCode).not.toHaveBeenCalled();

        await user.type(screen.getByLabelText('Promo code'), ' SALSA10 ');
        await user.type(screen.getByLabelText('Where you found it'), 'https://example.com/deal');
        await user.type(screen.getByLabelText('Details'), 'Ten percent off');
        await user.click(screen.getByRole('button', { name: 'Submit promo code' }));

        expect(submitEventPromoCode).toHaveBeenCalledWith('event-1', {
            code: 'SALSA10',
            description: 'Ten percent off',
            source_url: 'https://example.com/deal',
            expires_at: null,
        });
        expect(onSubmitted).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
        expect(await screen.findByText('Promo code submitted')).toBeInTheDocument();
    });

    it('rejects an invalid source URL', async () => {
        const user = userEvent.setup();
        render(
            <ToastProvider>
                <EventPromoCodeDialog eventId="event-1" onClose={vi.fn()} />
            </ToastProvider>,
        );

        await user.type(screen.getByLabelText('Promo code'), 'SALSA10');
        await user.type(screen.getByLabelText('Where you found it'), 'facebook.com/deal');
        await user.click(screen.getByRole('button', { name: 'Submit promo code' }));

        expect(screen.getByText('Enter a valid URL (including https://).')).toBeInTheDocument();
        expect(submitEventPromoCode).not.toHaveBeenCalled();
    });

    it('prefills and updates an existing promo code', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const promo = {
            id: 'promo-1',
            event_id: 'event-1',
            code: 'SALSA10',
            description: 'Ten percent off',
            source_url: 'https://example.com/deal',
            expires_at: null,
            status: 'approved' as const,
            submitter: { user_id: 'user-1', handle: null, display_name: 'Dancer', avatar_url: null },
            created_at: '2026-09-20T00:00:00Z',
            updated_at: '2026-09-20T00:00:00Z',
        };
        vi.mocked(updateEventPromoCode).mockResolvedValue({ ...promo, status: 'pending' });

        render(
            <ToastProvider>
                <EventPromoCodeDialog eventId="event-1" promo={promo} onClose={onClose} />
            </ToastProvider>,
        );

        expect(screen.getByRole('heading', { name: 'Edit promo code' })).toBeInTheDocument();
        expect(screen.getByLabelText('Promo code')).toHaveValue('SALSA10');
        await user.clear(screen.getByLabelText('Details'));
        await user.type(screen.getByLabelText('Details'), 'Updated offer');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        expect(updateEventPromoCode).toHaveBeenCalledWith('event-1', 'promo-1', {
            code: 'SALSA10',
            description: 'Updated offer',
            source_url: 'https://example.com/deal',
            expires_at: null,
        });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
