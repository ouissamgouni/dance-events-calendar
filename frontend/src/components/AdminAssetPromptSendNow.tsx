import { useEffect, useRef, useState } from 'react';
import {
    fetchAssetPromptCandidates,
    searchEvents,
    sendAssetPromptNow,
} from '../api';
import type {
    AssetPromptCandidate,
    AssetPromptCandidatesResponse,
    AssetPromptChannel,
    AssetPromptKind,
    EventSearchResult,
} from '../api';

const BLOCKER_LABELS: Record<NonNullable<AssetPromptCandidate['blocker']>, string> = {
    has_ticket: 'has ticket',
    ticket_not_needed: 'not needed',
    has_memory: 'has memory',
};

const INELIGIBLE_LABELS: Record<NonNullable<AssetPromptCandidatesResponse['ineligible_reason']>, string> = {
    not_upcoming: 'This event has already started — ticket prompts only go out before the event.',
    not_ended: "This event hasn't ended yet.",
    window_closed: 'The memory upload window for this event has closed.',
};

const CHANNELS: { key: AssetPromptChannel; label: string }[] = [
    { key: 'app', label: 'In-app' },
    { key: 'email', label: 'Email' },
    { key: 'push', label: 'Push' },
];

const CHIP_ON = 'bg-emerald-50 text-success';
const CHIP_OFF = 'bg-canvas text-muted';

function fmt(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
}

/** Default pick: unblocked users still missing a channel they can receive. */
function isMissingChannel(c: AssetPromptCandidate): boolean {
    if (c.blocker) return false;
    const n = c.notification;
    if (!n) return true;
    return (c.email_enabled && !n.emailed_at) || (c.push_enabled && c.has_push_subscription && !n.pushed_at);
}

function channelChips(c: AssetPromptCandidate): { label: string; text: string; on: boolean }[] {
    const n = c.notification;
    return [
        {
            label: 'In-app',
            text: n ? `✓ ${fmt(n.created_at)} · ${n.read_at ? 'read' : 'unread'}` : '—',
            on: !!n,
        },
        {
            label: 'Email',
            text: n?.emailed_at ? `✓ ${fmt(n.emailed_at)}` : c.email_enabled ? '—' : 'opted out',
            on: !!n?.emailed_at,
        },
        {
            label: 'Push',
            text: n?.pushed_at
                ? `✓ ${fmt(n.pushed_at)}`
                : !c.push_enabled ? 'opted out' : !c.has_push_subscription ? 'no device' : '—',
            on: !!n?.pushed_at,
        },
    ];
}

interface Props {
    kind: AssetPromptKind;
    onMessage?: (msg: string) => void;
}

/** Admin "Send now" for the ticket / memories prompt on one event. */
export default function AdminAssetPromptSendNow({ kind, onMessage }: Props) {
    const [event, setEvent] = useState<EventSearchResult | null>(null);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<EventSearchResult[]>([]);
    const [data, setData] = useState<AssetPromptCandidatesResponse | null>(null);
    const [loadError, setLoadError] = useState('');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [channels, setChannels] = useState<Record<AssetPromptChannel, boolean>>({ app: true, email: true, push: true });
    const [resend, setResend] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const currentEventId = useRef<string | null>(null);

    const trimmed = query.trim();
    useEffect(() => {
        if (trimmed.length < 2) return;
        const t = setTimeout(() => {
            searchEvents(trimmed, { limit: 8, dateScope: kind === 'ticket' ? 'upcoming' : 'past' })
                .then(setResults)
                .catch(() => setResults([]));
        }, 250);
        return () => clearTimeout(t);
    }, [trimmed, kind]);

    const load = (eventId: string, resetSelection: boolean) => {
        currentEventId.current = eventId;
        setLoadError('');
        fetchAssetPromptCandidates(eventId, kind)
            .then((d) => {
                if (currentEventId.current !== eventId) return;
                setData(d);
                if (resetSelection) {
                    setSelected(d.ineligible_reason
                        ? new Set()
                        : new Set(d.candidates.filter(isMissingChannel).map((c) => c.user_id)));
                }
            })
            .catch((e) => {
                if (currentEventId.current !== eventId) return;
                setLoadError(e instanceof Error ? e.message : 'Failed to load attendees');
            });
    };

    const pickEvent = (ev: EventSearchResult | null) => {
        setEvent(ev);
        setQuery('');
        setResults([]);
        setMessage('');
        setData(null);
        setSelected(new Set());
        currentEventId.current = null;
        if (ev) load(ev.event_id, true);
    };

    const loaded = data && event && data.event_id === event.event_id ? data : null;
    const selectable = loaded && !loaded.ineligible_reason
        ? loaded.candidates.filter((c) => !c.blocker)
        : [];
    const activeChannels = CHANNELS.filter((c) => channels[c.key]).map((c) => c.key);

    const toggleUser = (id: string) => {
        setMessage('');
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleSend = async () => {
        if (!event || selected.size === 0 || activeChannels.length === 0) return;
        setBusy(true);
        try {
            const res = await sendAssetPromptNow({
                kind,
                event_id: event.event_id,
                user_ids: [...selected],
                channels: activeChannels,
                resend,
            });
            const sent = res.results.filter((r) => r.status === 'sent').length;
            const skipped: Record<string, number> = {};
            for (const r of res.results) {
                if (r.status !== 'sent') skipped[r.status] = (skipped[r.status] ?? 0) + 1;
            }
            const skippedText = Object.entries(skipped)
                .map(([s, n]) => `${n} ${s.replace(/^skipped_/, '').replace(/_/g, ' ')}`)
                .join(', ');
            const label = kind === 'ticket' ? 'Ticket prompt' : 'Memories prompt';
            const msg = `${label} send-now: ${sent} of ${res.results.length} user(s) sent `
                + `(${res.in_app_created} in-app, ${res.in_app_resurfaced} resurfaced, ${res.emailed} email, ${res.pushed} push)`
                + (skippedText ? `; ${skippedText}.` : '.');
            setMessage(msg);
            onMessage?.(msg);
            load(event.event_id, true);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Failed to send prompt now.';
            setMessage(msg);
            onMessage?.(msg);
        } finally {
            setBusy(false);
        }
    };

    const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.user_id));

    return (
        <div className="space-y-1.5">
            <div>
                <span className="text-[11px] font-medium text-ink">Send now</span>
                <p className="text-[10px] text-muted">
                    {kind === 'ticket'
                        ? 'Send the ticket prompt for an upcoming event to going users now, ignoring timing, the toggle above and the ticket-likely rule.'
                        : 'Send the memories prompt for a past event to going users now, ignoring timing and the toggle above.'}
                    {' '}Opt-outs are respected; users who already sorted it are locked.
                </p>
            </div>
            {event ? (
                <div className="flex items-center gap-2 text-[11px] border border-line rounded-field px-2 py-1">
                    <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-ink">{event.title}</span>
                        {event.start && <span className="text-muted"> · {new Date(event.start).toLocaleDateString()}</span>}
                    </span>
                    <button
                        type="button"
                        onClick={() => pickEvent(null)}
                        className="text-muted hover:text-ink-soft"
                        aria-label="Clear selected event"
                    >
                        ✕
                    </button>
                </div>
            ) : (
                <div className="relative">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={kind === 'ticket' ? 'Search upcoming event by title' : 'Search past event by title'}
                        className="w-full text-[11px] border border-line rounded-field px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-success"
                        aria-label={`Search event for ${kind} prompt`}
                    />
                    {trimmed.length >= 2 && results.length > 0 && (
                        <ul className="absolute z-10 mt-0.5 w-full max-h-48 overflow-auto bg-surface border border-line rounded-field shadow">
                            {results.map((ev) => (
                                <li key={ev.event_id}>
                                    <button
                                        type="button"
                                        onClick={() => pickEvent(ev)}
                                        className="w-full text-left text-[11px] px-2 py-1 hover:bg-canvas"
                                    >
                                        <span className="font-medium text-ink">{ev.title}</span>
                                        {ev.start && <span className="text-muted"> · {new Date(ev.start).toLocaleDateString()}</span>}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
            {event && loaded?.ineligible_reason && (
                <p className="text-[10px] text-ink-soft bg-canvas border border-line px-2 py-1">
                    {INELIGIBLE_LABELS[loaded.ineligible_reason]}
                </p>
            )}
            {event && kind === 'ticket' && loaded && !loaded.ineligible_reason && !loaded.ticket_likely && (
                <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1">
                    Not ticket-likely — users wouldn't normally get this prompt.
                </p>
            )}
            {event && (
                <div className="border border-line rounded-field">
                    <div className="flex items-center justify-between px-2 py-1 border-b border-card-line">
                        <span className="text-[10px] font-medium text-ink-soft">
                            Going{loaded?.candidates.length ? ` (${loaded.candidates.length})` : ''}
                            {selected.size > 0 && ` · ${selected.size} selected`}
                        </span>
                        {selectable.length > 0 && (
                            <button
                                type="button"
                                className="text-[10px] text-success hover:underline"
                                onClick={() => {
                                    setMessage('');
                                    setSelected(allSelected ? new Set() : new Set(selectable.map((c) => c.user_id)));
                                }}
                            >
                                {allSelected ? 'Clear all' : 'Select all'}
                            </button>
                        )}
                    </div>
                    {loadError ? (
                        <p className="text-[10px] text-danger px-2 py-2">{loadError}</p>
                    ) : !loaded ? (
                        <p className="text-[10px] text-muted px-2 py-2">Loading going users…</p>
                    ) : loaded.candidates.length === 0 ? (
                        <p className="text-[10px] text-muted px-2 py-2">Nobody is going to this event.</p>
                    ) : (
                        <ul className="max-h-56 overflow-auto divide-y divide-card-line">
                            {loaded.candidates.map((c) => {
                                const locked = !!c.blocker || !!loaded.ineligible_reason;
                                return (
                                    <li key={c.user_id}>
                                        <label
                                            className={`flex items-start gap-2 px-2 py-1 text-[11px] ${locked ? 'text-muted' : 'text-ink hover:bg-canvas cursor-pointer'}`}
                                        >
                                            <input
                                                type="checkbox"
                                                className="mt-0.5"
                                                disabled={locked}
                                                checked={selected.has(c.user_id)}
                                                onChange={() => toggleUser(c.user_id)}
                                                aria-label={`Select ${c.name || c.handle || c.email}`}
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate">
                                                    {c.name || c.handle || c.email}
                                                    <span className="text-muted"> · {c.email}</span>
                                                    {c.curator_marked && <span className="ml-1 text-[9px] text-muted">admin-marked</span>}
                                                </span>
                                                <span className="mt-0.5 flex flex-wrap gap-1">
                                                    {channelChips(c).map((chip) => (
                                                        <span
                                                            key={chip.label}
                                                            className={`text-[9px] px-1 rounded-field ${chip.on ? CHIP_ON : CHIP_OFF}`}
                                                        >
                                                            {chip.label}: {chip.text}
                                                        </span>
                                                    ))}
                                                </span>
                                            </span>
                                            {c.blocker && <span className="text-[9px] text-muted">{BLOCKER_LABELS[c.blocker]}</span>}
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
                {CHANNELS.map((ch) => (
                    <label key={ch.key} className="flex items-center gap-1 text-[10px] text-ink-soft">
                        <input
                            type="checkbox"
                            checked={channels[ch.key]}
                            onChange={(e) => setChannels((prev) => ({ ...prev, [ch.key]: e.target.checked }))}
                        />
                        {ch.label}
                    </label>
                ))}
                <label
                    className="flex items-center gap-1 text-[10px] text-ink-soft"
                    title="Re-send the checked channels even if already delivered; in-app moves back to the top as unread"
                >
                    <input type="checkbox" checked={resend} onChange={(e) => setResend(e.target.checked)} />
                    Resend
                </label>
                <button
                    type="button"
                    onClick={handleSend}
                    disabled={!loaded || !!loaded.ineligible_reason || selected.size === 0 || activeChannels.length === 0 || busy}
                    className="ml-auto text-[11px] px-2.5 py-1 rounded-field bg-success text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-success/90"
                >
                    {busy ? 'Sending…' : `Send now${selected.size ? ` (${selected.size})` : ''}`}
                </button>
            </div>
            {message && (
                <div className="text-[10px] text-ink-soft bg-canvas border border-line p-2">{message}</div>
            )}
        </div>
    );
}
