import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { deleteOwnSuggestion, fetchOwnSuggestionForEvent, requestOwnSuggestionPublic, withdrawOwnSuggestion, withdrawOwnSuggestionChanges } from '../../api';
import type { OwnSuggestion } from '../../types';

interface Props {
    eventId: string;
}

const rowCls = 'mt-3 flex flex-wrap items-center gap-2';
const pillCls = 'rounded-field border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink transition hover:bg-canvas';

/** Edit / withdraw controls shown to the submitter of a suggested event. */
export default function OwnSuggestionActions({ eventId }: Props) {
    const navigate = useNavigate();
    const location = useLocation();
    const [suggestion, setSuggestion] = useState<OwnSuggestion | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        fetchOwnSuggestionForEvent(eventId)
            .then((own) => {
                if (!cancelled) setSuggestion(own);
            })
            .catch(() => {
                if (!cancelled) setSuggestion(null);
            });
        return () => {
            cancelled = true;
        };
    }, [eventId]);

    if (!suggestion) return null;

    if (suggestion.status === 'withdrawn') {
        return <p className={`${rowCls} text-xs text-ink-soft`}>You deleted this event.</p>;
    }
    if (suggestion.edit_locked) {
        return <p className={`${rowCls} text-xs text-ink-soft`}>An admin has locked this event.</p>;
    }

    const act = async (action: () => Promise<OwnSuggestion>, fallback: string) => {
        setBusy(true);
        setError('');
        try {
            setSuggestion(await action());
            setConfirming(false);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : fallback);
        } finally {
            setBusy(false);
        }
    };
    const withdrawChanges = () => act(() => withdrawOwnSuggestionChanges(suggestion.id), 'Failed to withdraw changes');

    if (suggestion.status === 'approved') {
        return (
            <div className={rowCls}>
                <button
                    type="button"
                    onClick={() =>
                        navigate(`/suggest/${suggestion.id}/edit`, { state: { backgroundLocation: location } })
                    }
                    className={pillCls}
                >
                    Edit event
                </button>
                {suggestion.pending_changes ? (
                    <>
                        <span className="text-xs text-ink">Changes awaiting review.</span>
                        <button
                            type="button"
                            onClick={withdrawChanges}
                            disabled={busy}
                            className={pillCls}
                        >
                            {busy ? 'Withdrawing…' : 'Withdraw changes'}
                        </button>
                    </>
                ) : null}
                <Link to="/me/submissions" className={pillCls}>Events I added</Link>
                {error ? <span className="text-xs text-danger">{error}</span> : null}
            </div>
        );
    }
    if (!['private', 'pending', 'declined'].includes(suggestion.status)) return null;

    if (confirming) {
        return (
            <div className={rowCls}>
                <span className="text-xs text-ink">Delete this event? Its dates will be removed.</span>
                <button
                    type="button"
                    onClick={() => act(() => deleteOwnSuggestion(suggestion.id), 'Failed to delete event')}
                    disabled={busy}
                    className="rounded-field bg-danger px-3 py-1 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {busy ? 'Deleting…' : 'Delete'}
                </button>
                <button type="button" onClick={() => setConfirming(false)} className={pillCls}>
                    Keep
                </button>
                {error ? <span className="text-xs text-danger">{error}</span> : null}
            </div>
        );
    }

    return (
        <div className={rowCls}>
            <button
                type="button"
                onClick={() =>
                    navigate(`/suggest/${suggestion.id}/edit`, { state: { backgroundLocation: location } })
                }
                className={pillCls}
            >
                Edit event
            </button>
            {suggestion.status === 'pending' ? (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(() => withdrawOwnSuggestion(suggestion.id), 'Failed to cancel the request')}
                    className={pillCls}
                >
                    Keep it private
                </button>
            ) : (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(() => requestOwnSuggestionPublic(suggestion.id), 'Failed to send for review')}
                    className={pillCls}
                >
                    Ask to make public
                </button>
            )}
            <button type="button" onClick={() => setConfirming(true)} className={pillCls}>
                Delete
            </button>
            <Link to="/me/submissions" className={pillCls}>Events I added</Link>
            {error ? <span className="text-xs text-danger">{error}</span> : null}
        </div>
    );
}
