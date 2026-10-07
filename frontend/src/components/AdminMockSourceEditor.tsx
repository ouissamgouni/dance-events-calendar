import { useEffect, useState } from 'react';
import { deleteMockSourceEvent, editMockSourceEvent, fetchMockSourceEvent } from '../api';
import type { MockSourceEvent } from '../types';

interface Props {
    eventId: string;
    /** Reload the event and its moderation state after a sync. */
    onSynced: () => void;
}

type Form = Pick<MockSourceEvent, 'title' | 'location' | 'description' | 'start' | 'end' | 'all_day'>;

const inputCls = 'w-full rounded-field border border-line bg-surface px-2 py-1 text-xs';
const labelCls = 'text-[10px] uppercase tracking-wide text-muted';

// The mock source stores naive UTC; inputs show that wall-clock time as-is.
const toInput = (value: string) => value.slice(0, 16);

function formFrom(source: MockSourceEvent): Form {
    return {
        title: source.title,
        location: source.location ?? '',
        description: source.description ?? '',
        start: toInput(source.start),
        end: toInput(source.end),
        all_day: source.all_day,
    };
}

/**
 * Dev-only tool: emulates the organiser editing or deleting this event in
 * Google. Renders nothing unless the backend runs the mock calendar.
 */
export default function AdminMockSourceEditor({ eventId, onSynced }: Props) {
    const [source, setSource] = useState<MockSourceEvent | null>(null);
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState<Form | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        fetchMockSourceEvent(eventId)
            .then((row) => { if (!cancelled) setSource(row); })
            .catch(() => { if (!cancelled) setSource(null); });
        return () => { cancelled = true; };
    }, [eventId]);

    if (!source) return null;

    const start = () => {
        setForm(formFrom(source));
        setMessage('');
        setError('');
        setOpen(true);
    };

    const save = async () => {
        if (!form) return;
        const initial = formFrom(source);
        const changes = Object.fromEntries(
            (Object.keys(form) as (keyof Form)[])
                .filter((key) => form[key] !== initial[key])
                .map((key) => [key, form[key] === '' && key !== 'title' ? null : form[key]]),
        );
        if (Object.keys(changes).length === 0) {
            setOpen(false);
            return;
        }
        setBusy(true);
        setError('');
        try {
            const result = await editMockSourceEvent(eventId, changes);
            setSource(result.source);
            setOpen(false);
            setMessage('Saved at the source and synced.');
            onSynced();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to edit the source event');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        setError('');
        try {
            const result = await deleteMockSourceEvent(eventId);
            setSource(result.source);
            setConfirmDelete(false);
            setOpen(false);
            setMessage('Deleted at the source and synced.');
            onSynced();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to delete the source event');
        } finally {
            setBusy(false);
        }
    };

    const set = <K extends keyof Form>(key: K, value: Form[K]) =>
        setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

    return (
        <section className="rounded-card border border-dashed border-line bg-canvas p-3" aria-label="Mock calendar source">
            <div className="flex flex-wrap items-center gap-2">
                <span className="bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-soft">Dev · mock source</span>
                <span className="text-[11px] text-ink-soft">
                    {source.deleted
                        ? 'Deleted at the source.'
                        : source.edited
                          ? 'Edited at the source.'
                          : 'Emulate the organiser changing this event in Google.'}
                </span>
                {!open && !source.deleted && (
                    <button
                        type="button"
                        onClick={start}
                        className="ml-auto border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-canvas"
                    >
                        Edit at source
                    </button>
                )}
            </div>

            {open && form && (
                <div className="mt-3 space-y-2">
                    <label className="block">
                        <span className={labelCls}>Title</span>
                        <input className={inputCls} value={form.title} onChange={(e) => set('title', e.target.value)} />
                    </label>
                    <label className="block">
                        <span className={labelCls}>Location</span>
                        <input className={inputCls} value={form.location ?? ''} onChange={(e) => set('location', e.target.value)} />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                            <span className={labelCls}>Start (UTC)</span>
                            <input type="datetime-local" className={inputCls} value={form.start} onChange={(e) => set('start', e.target.value)} />
                        </label>
                        <label className="block">
                            <span className={labelCls}>End (UTC)</span>
                            <input type="datetime-local" className={inputCls} value={form.end} onChange={(e) => set('end', e.target.value)} />
                        </label>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-ink">
                        <input type="checkbox" checked={form.all_day} onChange={(e) => set('all_day', e.target.checked)} className="h-3.5 w-3.5" />
                        All day
                    </label>
                    <label className="block">
                        <span className={labelCls}>Description</span>
                        <textarea rows={3} className={inputCls} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} />
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={save}
                            disabled={busy}
                            className="bg-action px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {busy ? 'Syncing…' : 'Save & sync'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            className="border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-canvas"
                        >
                            Cancel
                        </button>
                        {confirmDelete ? (
                            <span className="ml-auto flex items-center gap-2">
                                <span className="text-xs text-ink">Delete it in the source calendar?</span>
                                <button
                                    type="button"
                                    onClick={remove}
                                    disabled={busy}
                                    className="bg-danger px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Delete
                                </button>
                                <button type="button" onClick={() => setConfirmDelete(false)} className="text-xs text-ink-soft hover:text-ink">
                                    Keep
                                </button>
                            </span>
                        ) : (
                            <button type="button" onClick={() => setConfirmDelete(true)} className="ml-auto text-xs font-medium text-danger hover:underline">
                                Delete at source…
                            </button>
                        )}
                    </div>
                </div>
            )}

            {message && <p className="mt-2 text-[11px] text-ink-soft">{message}</p>}
            {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
        </section>
    );
}
