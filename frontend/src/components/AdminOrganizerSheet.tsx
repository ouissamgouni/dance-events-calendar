import { useEffect, useRef, useState } from 'react';
import { Search, Undo2, X } from 'lucide-react';
import {
    adminUpdateUserOrganizer,
    fetchAdminOrganizedEvents,
    searchEvents,
    type EventSearchResult,
} from '../api';
import type { OrganizedEvent } from '../types';
import BottomSheet from './BottomSheet';

interface Props {
    userId: string;
    label: string;
    verified: boolean;
    onClose: () => void;
    onChanged: () => void;
}

function formatDate(iso: string | null) {
    return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

/** Admin: make a user an organizer and attribute events to them; nothing applies until Save. */
export default function AdminOrganizerSheet({ userId, label, verified: initialVerified, onClose, onChanged }: Props) {
    const [verified, setVerified] = useState(initialVerified);
    const [events, setEvents] = useState<OrganizedEvent[] | null>(null);
    const [toAdd, setToAdd] = useState<OrganizedEvent[]>([]);
    const [toRemove, setToRemove] = useState<Set<string>>(new Set());
    const [q, setQ] = useState('');
    const [results, setResults] = useState<EventSearchResult[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<number | null>(null);

    useEffect(() => {
        fetchAdminOrganizedEvents(userId).then(setEvents).catch(() => setEvents([]));
    }, [userId]);

    useEffect(() => {
        const term = q.trim();
        if (timer.current) window.clearTimeout(timer.current);
        if (term.length < 2) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced typeahead lifecycle
            setResults([]);
            return;
        }
        timer.current = window.setTimeout(() => {
            searchEvents(term, { limit: 8, dateScope: 'all' }).then(setResults).catch(() => setResults([]));
        }, 250);
        return () => { if (timer.current) window.clearTimeout(timer.current); };
    }, [q]);

    const assignedIds = new Set([...(events ?? []).map((e) => e.event_id), ...toAdd.map((e) => e.event_id)]);
    // Assigning an event verifies the user, so the badge can't be switched off alongside it.
    const effectiveVerified = verified || toAdd.length > 0;
    const dirty = effectiveVerified !== initialVerified || toAdd.length > 0 || toRemove.size > 0;
    const notifies = toAdd.length > 0 || (effectiveVerified && !initialVerified);

    const stageAdd = (r: EventSearchResult) => {
        setToAdd((prev) => [...prev, { event_id: r.event_id, title: r.title, start: r.start, city: r.city ?? null }]);
        setQ('');
    };

    const toggleRemove = (eventId: string) => setToRemove((prev) => {
        const next = new Set(prev);
        if (next.has(eventId)) next.delete(eventId);
        else next.add(eventId);
        return next;
    });

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            await adminUpdateUserOrganizer(userId, {
                is_verified_organizer: effectiveVerified,
                add_event_ids: toAdd.map((e) => e.event_id),
                remove_event_ids: [...toRemove],
            });
            onChanged();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save changes');
        } finally {
            setSaving(false);
        }
    };

    const footer = (
        <div className="space-y-2">
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            {notifies && <p className="text-xs text-ink-soft">{label} will be notified.</p>}
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    disabled={saving}
                    className="min-h-11 rounded-field border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || saving}
                    className="min-h-11 rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Save changes'}
                </button>
            </div>
        </div>
    );

    return (
        <BottomSheet title="Organizer" subtitle={label} titleSize="large" onClose={onClose} desktop="modal" dismissible={!saving} footer={footer}>
            <div className="space-y-6 pb-4">
                <label className="flex min-h-12 items-center justify-between gap-3">
                    <span>
                        <span className="block text-sm font-semibold text-ink">Verified organizer</span>
                        <span className="block text-sm text-ink-soft">Shows the badge. Assigning an event turns it on.</span>
                    </span>
                    <input
                        type="checkbox"
                        checked={effectiveVerified}
                        disabled={saving || toAdd.length > 0}
                        onChange={() => setVerified((v) => !v)}
                        className="h-5 w-5"
                    />
                </label>

                <section>
                    <h3 className="text-sm font-semibold text-ink">Events they organize</h3>
                    {events === null ? (
                        <p className="mt-2 text-sm text-muted">Loading…</p>
                    ) : events.length === 0 && toAdd.length === 0 ? (
                        <p className="mt-2 text-sm text-ink-soft">No events yet.</p>
                    ) : (
                        <ul className="mt-2 divide-y divide-card-line">
                            {toAdd.map((e) => (
                                <li key={e.event_id} className="flex min-h-12 items-center gap-2" data-testid="staged-add">
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm text-ink">{e.title}</span>
                                        <span className="block text-xs text-ink-soft">{[formatDate(e.start), e.city].filter(Boolean).join(' · ')}</span>
                                    </span>
                                    <span className="shrink-0 bg-blue-50 px-2 py-0.5 text-xs font-semibold text-action">To add</span>
                                    <button
                                        type="button"
                                        onClick={() => setToAdd((prev) => prev.filter((x) => x.event_id !== e.event_id))}
                                        disabled={saving}
                                        aria-label={`Don't add ${e.title}`}
                                        className="flex h-10 w-10 items-center justify-center text-ink-soft hover:text-ink disabled:opacity-50"
                                    >
                                        <X className="h-4 w-4" aria-hidden />
                                    </button>
                                </li>
                            ))}
                            {(events ?? []).map((e) => {
                                const removing = toRemove.has(e.event_id);
                                return (
                                    <li key={e.event_id} className="flex min-h-12 items-center gap-2">
                                        <a href={`/event/${e.event_id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
                                            <span className={`block truncate text-sm hover:underline ${removing ? 'text-ink-soft line-through' : 'text-ink'}`}>{e.title}</span>
                                            <span className="block text-xs text-ink-soft">{[formatDate(e.start), e.city].filter(Boolean).join(' · ')}</span>
                                        </a>
                                        {removing && <span className="shrink-0 bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">To remove</span>}
                                        <button
                                            type="button"
                                            onClick={() => toggleRemove(e.event_id)}
                                            disabled={saving}
                                            aria-label={removing ? `Keep ${e.title}` : `Remove ${e.title}`}
                                            className="flex h-10 w-10 items-center justify-center text-ink-soft hover:text-danger disabled:opacity-50"
                                        >
                                            {removing ? <Undo2 className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>

                <section>
                    <h3 className="text-sm font-semibold text-ink">Assign an event</h3>
                    <div className="relative mt-2">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
                        <input
                            type="search"
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Search events"
                            aria-label="Search events to assign"
                            className="w-full rounded-field border border-line bg-surface py-2.5 pl-9 pr-3 text-sm text-ink focus:border-action focus:outline-none"
                        />
                    </div>
                    {results.length > 0 && (
                        <ul className="mt-2 divide-y divide-card-line overflow-hidden rounded-field border border-line">
                            {results.map((r) => {
                                const mine = assignedIds.has(r.event_id);
                                return (
                                    <li key={r.event_id}>
                                        <button
                                            type="button"
                                            disabled={mine || saving}
                                            onClick={() => stageAdd(r)}
                                            className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-canvas disabled:opacity-60"
                                        >
                                            <span className="min-w-0">
                                                <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                                                <span className="block truncate text-xs text-ink-soft">{[formatDate(r.start), r.city].filter(Boolean).join(' · ')}</span>
                                            </span>
                                            <span className="shrink-0 text-xs font-semibold text-action">
                                                {mine ? 'Assigned' : r.has_organizer ? 'Reassign' : 'Assign'}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </div>
        </BottomSheet>
    );
}
