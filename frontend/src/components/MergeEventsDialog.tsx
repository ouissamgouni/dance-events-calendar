import { useEffect, useState } from 'react';
import { fetchMergePreview, mergeEvents, type MergeFieldKey, type MergePreview, type MergeEventsResult } from '../api';
import useBackToClose from '../hooks/useBackToClose';

interface Props {
    eventIds: string[];
    /** Preselected event to keep; the first one otherwise. */
    initialTargetId?: string;
    onClose: () => void;
    onMerged: (result: MergeEventsResult) => void;
}

type TimeValue = { start: string; end: string; all_day: boolean; timezone: string | null };
type PriceValue = { price_min: number | null; price_max: number | null; price_currency: string | null; price_is_free: boolean | null };
type LinkValue = { url?: string; label?: string };

const COUNT_LABELS: Record<string, string> = {
    saved: 'saved',
    going: 'going',
    reviews: 'reviews',
    messages: 'messages',
    pictures: 'pictures',
    promo_codes: 'promo codes',
};

function formatTime(value: unknown): string {
    const t = value as TimeValue | null;
    if (!t?.start) return '—';
    const opts: Intl.DateTimeFormatOptions = t.all_day
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    const start = new Date(t.start).toLocaleString(undefined, opts);
    const end = new Date(t.end).toLocaleString(undefined, t.all_day ? opts : { hour: '2-digit', minute: '2-digit' });
    return `${start} – ${end}`;
}

function formatPrice(value: unknown): string {
    const p = value as PriceValue | null;
    if (!p) return '—';
    if (p.price_is_free) return 'Free';
    if (p.price_min == null && p.price_max == null) return '—';
    const range = p.price_min != null && p.price_max != null && p.price_min !== p.price_max
        ? `${p.price_min}–${p.price_max}`
        : String(p.price_min ?? p.price_max);
    return `${range} ${p.price_currency ?? ''}`.trim();
}

function linkList(value: unknown): LinkValue[] {
    return Array.isArray(value) ? (value as LinkValue[]) : [];
}

function FieldValue({ field, value }: { field: MergeFieldKey; value: unknown }) {
    if (field === 'time') return <span>{formatTime(value)}</span>;
    if (field === 'price') return <span>{formatPrice(value)}</span>;
    if (field === 'picture') {
        return typeof value === 'string' && value
            ? <img src={value} alt="" className="h-12 w-20 object-cover" />
            : <span className="text-muted">No picture</span>;
    }
    if (field === 'links') {
        const links = linkList(value);
        return links.length === 0 ? <span className="text-muted">—</span> : (
            <ul className="space-y-0.5">
                {links.map((l) => <li key={l.url} className="truncate">{l.label || l.url}</li>)}
            </ul>
        );
    }
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? <span className={field === 'description' ? 'line-clamp-3' : ''}>{text}</span> : <span className="text-muted">—</span>;
}

export default function MergeEventsDialog({ eventIds, initialTargetId, onClose, onMerged }: Props) {
    useBackToClose(onClose, true);
    const [preview, setPreview] = useState<MergePreview | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [targetId, setTargetId] = useState(initialTargetId ?? eventIds[0]);
    const [choices, setChoices] = useState<Partial<Record<MergeFieldKey, string>>>({});
    const [combineTags, setCombineTags] = useState(true);
    const [combineLinks, setCombineLinks] = useState(true);
    const [note, setNote] = useState('');
    const [notify, setNotify] = useState(true);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const idsKey = eventIds.join(',');

    useEffect(() => {
        let cancelled = false;
        fetchMergePreview(idsKey.split(','))
            .then((p) => { if (!cancelled) setPreview(p); })
            .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load'); });
        return () => { cancelled = true; };
    }, [idsKey]);

    const events = preview?.events ?? [];
    const target = events.find((e) => e.event_id === targetId) ?? events[0];
    const chosen = (key: MergeFieldKey) => choices[key] ?? target?.event_id;
    const differing = preview?.fields.filter((f) => !f.identical) ?? [];
    const identical = preview?.fields.filter((f) => f.identical) ?? [];
    const allTags = new Set(events.flatMap((e) => e.tag_ids));
    const tagsDiffer = events.some((e) => e.tag_ids.length !== allTags.size);
    const others = events.filter((e) => e.event_id !== target?.event_id);
    const gridVars = { '--merge-cols': `repeat(${events.length + 1}, minmax(0, 1fr))` } as React.CSSProperties;

    const resultValue = (key: MergeFieldKey) => {
        if (key === 'links' && combineLinks) {
            const seen = new Map<string, LinkValue>();
            for (const e of events) for (const l of linkList(e.values.links)) if (l.url && !seen.has(l.url)) seen.set(l.url, l);
            return [...seen.values()];
        }
        return events.find((e) => e.event_id === chosen(key))?.values[key];
    };

    const submit = async () => {
        if (!target) return;
        setBusy(true);
        setError(null);
        try {
            const fields: Partial<Record<MergeFieldKey, string>> = {};
            for (const f of differing) fields[f.key] = chosen(f.key);
            const result = await mergeEvents({
                target_event_id: target.event_id,
                event_ids: others.map((e) => e.event_id),
                fields,
                combine_tags: combineTags,
                combine_links: combineLinks,
                note: note.trim() || null,
                notify: notify && (preview?.affected_users ?? 0) > 0,
            });
            onMerged(result);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to merge events');
            setConfirming(false);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/30 sm:items-center" role="dialog" aria-modal="true" aria-label="Merge events">
            <div className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-card bg-surface shadow-xl">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                    <h2 className="text-base font-semibold text-ink">Merge {eventIds.length} events</h2>
                    <button type="button" onClick={onClose} aria-label="Close" className="px-2 text-sm text-muted hover:text-ink">✕</button>
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs text-ink">
                    {loadError && <p className="text-danger">{loadError}</p>}
                    {!preview && !loadError && <p className="text-muted">Loading…</p>}
                    {preview && target && (
                        <>
                            <div className="grid grid-cols-1 gap-2 md:[grid-template-columns:var(--merge-cols)]" style={gridVars}>
                                {events.map((e) => (
                                    <EventHeader key={e.event_id} event={e} selected={e.event_id === target.event_id} onSelect={() => setTargetId(e.event_id)} />
                                ))}
                                <div className="hidden p-2 text-[11px] font-semibold uppercase tracking-wide text-ink-soft md:block">Result</div>
                            </div>

                            {differing.map((field) => (
                                <section key={field.key} className="space-y-1">
                                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{field.label}</h3>
                                    <div className="grid grid-cols-1 gap-2 md:[grid-template-columns:var(--merge-cols)]" style={gridVars}>
                                        {events.map((e) => {
                                            const picked = chosen(field.key) === e.event_id;
                                            const disabled = field.key === 'links' && combineLinks;
                                            return (
                                                <label
                                                    key={e.event_id}
                                                    className={`flex cursor-pointer gap-2 border p-2 ${picked && !disabled ? 'border-action bg-blue-50' : 'border-line'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
                                                >
                                                    <input
                                                        type="radio"
                                                        name={`merge-${field.key}`}
                                                        checked={picked}
                                                        disabled={disabled}
                                                        onChange={() => setChoices((c) => ({ ...c, [field.key]: e.event_id }))}
                                                        className="mt-0.5"
                                                        aria-label={`${field.label} from ${String(e.values.title)}`}
                                                    />
                                                    <span className="min-w-0 flex-1"><FieldValue field={field.key} value={e.values[field.key]} /></span>
                                                </label>
                                            );
                                        })}
                                        <div className="border border-dashed border-line bg-canvas p-2" data-testid={`merge-result-${field.key}`}>
                                            <span className="mb-1 block text-[10px] font-semibold uppercase text-ink-soft md:hidden">Result</span>
                                            <FieldValue field={field.key} value={resultValue(field.key)} />
                                        </div>
                                    </div>
                                    {field.key === 'links' && (
                                        <label className="flex items-center gap-2 text-ink">
                                            <input type="checkbox" checked={combineLinks} onChange={(e) => setCombineLinks(e.target.checked)} />
                                            Combine links from all events
                                        </label>
                                    )}
                                </section>
                            ))}

                            {identical.length > 0 && (
                                <p className="text-ink-soft">
                                    {identical.length} identical field{identical.length === 1 ? '' : 's'}: {identical.map((f) => f.label).join(', ')}.
                                </p>
                            )}

                            {tagsDiffer && (
                                <label className="flex items-center gap-2">
                                    <input type="checkbox" checked={combineTags} onChange={(e) => setCombineTags(e.target.checked)} />
                                    Combine tags ({allTags.size} in total; otherwise keep the {target.tag_ids.length} of the kept event)
                                </label>
                            )}

                            <div className="space-y-1">
                                <label htmlFor="merge-note" className="block text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Note (admin only)</label>
                                <textarea
                                    id="merge-note"
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    maxLength={500}
                                    rows={2}
                                    className="w-full rounded-field border border-line px-2 py-1 text-xs"
                                />
                            </div>

                            <label className={`flex items-center gap-2 ${preview.affected_users === 0 ? 'text-muted' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={notify && preview.affected_users > 0}
                                    disabled={preview.affected_users === 0}
                                    onChange={(e) => setNotify(e.target.checked)}
                                />
                                {preview.affected_users === 0
                                    ? 'Notify people (nobody has saved or is going yet)'
                                    : `Notify ${preview.affected_users} ${preview.affected_users === 1 ? 'person' : 'people'} who saved or are going`}
                            </label>

                            <p className="border border-amber-200 bg-amber-50 p-2 text-amber-800">
                                This can't be undone. {others.map((e) => String(e.values.title)).join(', ')} will be removed; their saves, Going,
                                reviews, messages and pictures move to “{String(target.values.title)}”, and their links open it instead.
                            </p>
                        </>
                    )}
                    {error && <p className="text-danger">{error}</p>}
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
                    <button type="button" onClick={onClose} className="border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-canvas">
                        Cancel
                    </button>
                    {confirming ? (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={submit}
                            className="bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {busy ? 'Merging…' : `Yes, merge ${eventIds.length} events`}
                        </button>
                    ) : (
                        <button
                            type="button"
                            disabled={!preview || !target}
                            onClick={() => setConfirming(true)}
                            className="bg-action px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Merge…
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function EventHeader({ event, selected, onSelect }: {
    event: MergePreview['events'][number];
    selected: boolean;
    onSelect: () => void;
}) {
    const counts = Object.entries(event.counts).filter(([, n]) => n > 0);
    return (
        <label className={`block cursor-pointer border p-2 ${selected ? 'border-action bg-blue-50' : 'border-line'}`}>
            <span className="flex items-center gap-2">
                <input type="radio" name="merge-target" checked={selected} onChange={onSelect} aria-label={`Keep ${String(event.values.title)}`} />
                <span className="text-[11px] font-semibold text-ink-soft">{selected ? 'Kept' : 'Keep this one'}</span>
            </span>
            <span className="mt-1 block truncate text-xs font-semibold text-ink">{String(event.values.title)}</span>
            <span className="block text-[11px] text-ink-soft">{formatTime(event.values.time)}</span>
            <span className="block truncate text-[10px] text-muted">{event.event_id}{event.is_submission ? ' · submission' : ''}</span>
            <span className="mt-1 block text-[11px] text-ink-soft">
                {counts.length === 0 ? 'No engagement' : counts.map(([k, n]) => `${n} ${COUNT_LABELS[k] ?? k}`).join(' · ')}
            </span>
        </label>
    );
}
