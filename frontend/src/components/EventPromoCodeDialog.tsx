import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { submitEventPromoCode, updateEventPromoCode } from '../api';
import type { PromoCode } from '../types';
import { useToast } from './Toast';
import PromoCodeFields, {
    promoCodeFormError,
    type PromoCodeFormValue,
} from './PromoCodeFields';
import { btnPrimary, errorCls } from './suggest/formState';

interface Props {
    eventId: string;
    promo?: PromoCode;
    onClose: () => void;
    onSubmitted?: (promo: PromoCode) => void;
}

const emptyValue: PromoCodeFormValue = {
    code: '',
    sourceUrl: '',
    description: '',
    expiresAt: '',
};

export default function EventPromoCodeDialog({ eventId, promo, onClose, onSubmitted }: Props) {
    const toast = useToast();
    const [value, setValue] = useState<PromoCodeFormValue>(() => promo ? {
        code: promo.code,
        sourceUrl: promo.source_url ?? '',
        description: promo.description ?? '',
        expiresAt: promo.expires_at?.slice(0, 10) ?? '',
    } : emptyValue);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !submitting) onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onClose, submitting]);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        const nextError = promoCodeFormError(value, true);
        if (nextError) {
            setError(nextError);
            return;
        }

        setSubmitting(true);
        setError(null);
        try {
            const body = {
                code: value.code.trim(),
                description: value.description.trim() || null,
                source_url: value.sourceUrl.trim() || null,
                expires_at: value.expiresAt ? new Date(value.expiresAt).toISOString() : null,
            };
            const saved = promo
                ? await updateEventPromoCode(eventId, promo.id, body)
                : await submitEventPromoCode(eventId, body);
            toast.push({
                title: promo ? 'Promo code updated' : 'Promo code submitted',
                message: promo
                    ? 'Your changes are awaiting admin approval.'
                    : 'It is awaiting admin approval.',
                variant: 'success',
            });
            onSubmitted?.(saved);
            onClose();
        } catch (caught: unknown) {
            setError(caught instanceof Error ? caught.message : 'Failed to submit promo code.');
        } finally {
            setSubmitting(false);
        }
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[12000] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
            onClick={() => { if (!submitting) onClose(); }}
        >
            <form
                role="dialog"
                aria-modal="true"
                aria-labelledby="event-promo-title"
                noValidate
                onSubmit={submit}
                onClick={(event) => event.stopPropagation()}
                className="flex max-h-[85dvh] w-full flex-col rounded-t-card bg-surface shadow-2xl sm:max-w-md sm:rounded-card"
            >
                <header className="flex shrink-0 items-center gap-2 border-b border-card-line px-4 py-3">
                    <h2 id="event-promo-title" className="min-w-0 flex-1 text-base font-bold text-ink">
                        {promo ? 'Edit promo code' : 'Add promo code'}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={submitting}
                        aria-label="Close"
                        className="flex h-10 w-10 shrink-0 items-center justify-center text-ink-soft transition hover:bg-canvas hover:text-ink disabled:opacity-50"
                    >
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                    <PromoCodeFields
                        value={value}
                        onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
                        idPrefix="event-promo"
                        showExpiry
                    />
                    {error ? <p className={errorCls}>{error}</p> : null}
                </div>

                <footer className="shrink-0 border-t border-card-line bg-canvas px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-3">
                    <button type="submit" disabled={submitting} className={btnPrimary}>
                        {submitting
                            ? promo ? 'Saving…' : 'Submitting…'
                            : promo ? 'Save changes' : 'Submit promo code'}
                    </button>
                </footer>
            </form>
        </div>,
        document.body,
    );
}
