import { useEffect, useRef, useState } from 'react';
import { adminSetEventOrganizer, fetchAdminUsers, type AdminUserRow } from '../api';
import type { EventOrganizerMini } from '../types';

interface Props {
    eventId: string;
    organizer: EventOrganizerMini | null | undefined;
}

function nameOf(u: { handle: string | null; display_name: string | null }) {
    return u.handle ? `@${u.handle}` : u.display_name ?? 'user';
}

/** Admin event editor: set, change or clear the event's organizer. */
export default function AdminEventOrganizerField({ eventId, organizer: initial }: Props) {
    const [organizer, setOrganizer] = useState<EventOrganizerMini | null>(initial ?? null);
    const [editing, setEditing] = useState(false);
    const [q, setQ] = useState('');
    const [results, setResults] = useState<AdminUserRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<number | null>(null);

    useEffect(() => {
        const term = q.trim();
        if (timer.current) window.clearTimeout(timer.current);
        if (term.length < 2) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced typeahead lifecycle
            setResults([]);
            return;
        }
        timer.current = window.setTimeout(() => {
            fetchAdminUsers({ q: term, limit: 6 }).then((r) => setResults(r.items)).catch(() => setResults([]));
        }, 250);
        return () => { if (timer.current) window.clearTimeout(timer.current); };
    }, [q]);

    const save = async (userId: string | null) => {
        setBusy(true);
        setError(null);
        try {
            const res = await adminSetEventOrganizer(eventId, userId);
            setOrganizer(res.organizer);
            setEditing(false);
            setQ('');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update organizer');
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="mb-4 border-b border-card-line pb-4" aria-label="Organizer">
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">Organizer</p>
                    <p className="truncate text-sm text-ink">{organizer ? nameOf(organizer) : 'None'}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                    <button
                        type="button"
                        onClick={() => setEditing((v) => !v)}
                        className="border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-canvas"
                    >
                        {editing ? 'Close' : organizer ? 'Change' : 'Set'}
                    </button>
                    {organizer && (
                        <button
                            type="button"
                            onClick={() => save(null)}
                            disabled={busy}
                            className="border border-line bg-surface px-2 py-1 text-xs text-danger hover:bg-canvas disabled:opacity-50"
                        >
                            Remove
                        </button>
                    )}
                </div>
            </div>
            {editing && (
                <div className="mt-2">
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search users by handle, name or email"
                        aria-label="Search organizer"
                        className="w-full border border-line px-2 py-1.5 text-xs focus:border-action focus:outline-none"
                    />
                    {results.length > 0 && (
                        <ul className="mt-1 divide-y divide-card-line border border-line">
                            {results.map((u) => (
                                <li key={u.user_id}>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => save(u.user_id)}
                                        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-canvas disabled:opacity-50"
                                    >
                                        <span className="truncate text-ink">{nameOf(u)} <span className="text-muted">{u.email}</span></span>
                                        {u.is_verified_organizer && <span className="shrink-0 text-success">verified</span>}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="mt-1 text-[11px] text-muted">Assigning marks the user as a verified organizer.</p>
                </div>
            )}
            {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
        </section>
    );
}
