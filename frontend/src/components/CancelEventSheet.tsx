import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { proposeEventChange } from '../api';
import BottomSheet from './BottomSheet';

interface Props {
    eventId: string;
    eventTitle: string;
    /** Already cancelled: the sheet asks to restore it instead. */
    cancelled?: boolean;
    onClose: () => void;
    onSent?: () => void;
}

/** Organizer's cancellation (or restore) request; an admin applies it and attendees are told. */
export default function CancelEventSheet({ eventId, eventTitle, cancelled = false, onClose, onSent }: Props) {
    const [note, setNote] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    const send = async () => {
        setSending(true);
        setError(null);
        try {
            await proposeEventChange(
                eventId,
                cancelled
                    ? { is_cancelled: false, cancellation_note: null }
                    : { is_cancelled: true, cancellation_note: note.trim() || null },
            );
            setSent(true);
            onSent?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not send your request');
        } finally {
            setSending(false);
        }
    };

    const sheet = sent ? (
        <BottomSheet
            title="Sent for review"
            titleSize="large"
            onClose={onClose}
            footer={
                <button type="button" onClick={onClose} className="flex min-h-12 w-full items-center justify-center rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90">
                    Done
                </button>
            }
        >
            <div className="flex flex-col items-center gap-3 py-4 text-center">
                {/* eslint-disable-next-line no-restricted-syntax -- success badge is a circle by design */}
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-success">
                    <Check className="h-7 w-7" aria-hidden />
                </span>
                <p className="text-sm text-ink-soft">
                    {cancelled
                        ? 'Our team will restore the event shortly.'
                        : 'Our team will confirm the cancellation shortly. Everyone who saved or is going will then be notified.'}
                </p>
            </div>
        </BottomSheet>
    ) : (
        <BottomSheet
            title={cancelled ? 'Restore this event?' : 'Cancel this event?'}
            subtitle={eventTitle}
            titleSize="large"
            onClose={onClose}
            footer={
                <div className="space-y-2">
                    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                    <button
                        type="button"
                        onClick={send}
                        disabled={sending}
                        className={`flex min-h-12 w-full items-center justify-center rounded-field px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${cancelled ? 'bg-action' : 'bg-danger'}`}
                    >
                        {sending ? 'Sending…' : cancelled ? 'Request restore' : 'Request cancellation'}
                    </button>
                    <button type="button" onClick={onClose} className="flex min-h-11 w-full items-center justify-center text-sm font-semibold text-ink-soft hover:text-ink">
                        Keep as is
                    </button>
                </div>
            }
        >
            {cancelled ? (
                <p className="text-sm text-ink-soft">The event will show as happening again once our team approves.</p>
            ) : (
                <div className="space-y-3 pb-2">
                    <p className="text-sm text-ink-soft">
                        The event stays listed with a “Cancelled” label so attendees aren&apos;t left guessing. Our team confirms before anything changes.
                    </p>
                    <label className="block">
                        <span className="text-sm font-medium text-ink">Message for attendees (optional)</span>
                        <textarea
                            rows={3}
                            maxLength={500}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="e.g. Venue unavailable — tickets will be refunded"
                            className="mt-1 w-full rounded-field border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none"
                        />
                    </label>
                </div>
            )}
        </BottomSheet>
    );

    return createPortal(sheet, document.body);
}
