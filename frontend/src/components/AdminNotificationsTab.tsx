import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { fetchAdminNotificationsLog } from '../api';
import useMediaQuery from '../hooks/useMediaQuery';
import BottomSheet from './BottomSheet';
import AdminLoadMore from './AdminLoadMore';
import type {
    NotificationLogChannel,
    NotificationLogEntry,
    NotificationLogMode,
    NotificationLogSource,
    NotificationLogType,
} from '../api';

const PAGE_SIZE = 50;

const TYPE_LABELS: Record<string, string> = {
    interest_match: 'Interest match',
    activity_digest: 'Activity digest',
    event_reminder: 'Reminder',
};

const CHANNEL_BADGE: Record<string, string> = {
    app: 'inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-ink',
    email: 'inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-action',
    push: 'inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700',
};
const CHANNEL_BADGE_FALLBACK =
    'inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-ink-soft';
const CHANNEL_LABELS: Record<string, string> = {
    app: 'App',
    email: 'Email',
    push: 'Push',
};

function ChannelBadge({ channel }: { channel: string }) {
    const cls = CHANNEL_BADGE[channel] ?? CHANNEL_BADGE_FALLBACK;
    return <span className={cls}>{CHANNEL_LABELS[channel] ?? channel}</span>;
}

function formatLatency(seconds: number | null): string | null {
    if (seconds == null) return null;
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
}

function DeliveryCell({ row }: { row: NotificationLogEntry }) {
    const parts = [row.mode, row.source, formatLatency(row.latency_seconds)].filter(Boolean);
    return <span className="text-ink-soft whitespace-nowrap">{parts.length ? parts.join(' · ') : '—'}</span>;
}

/**
 * Plain-text, channel-agnostic description of what the notification is
 * about (``row.summary``, e.g. "Maria is going to Salsa Social Friday"),
 * reconstructed server-side from the same copy the real senders use — not
 * a verbatim record of the historically delivered email/push text. Links
 * to the related event when one is attached to the notification.
 */
function AboutCell({ row }: { row: NotificationLogEntry }) {
    return (
        <div className="max-w-[24rem]">
            <p className="text-ink">{row.summary}</p>
            {row.event_id && (
                <Link
                    to={`/event/${row.event_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-action hover:underline"
                >
                    View event ↗
                </Link>
            )}
        </div>
    );
}

/**
 * Admin Notifications tab.
 *
 * Read-only audit log of every notification *delivery event* ever recorded
 * (one row per ``NotificationDelivery`` DB row — a single notification can
 * produce up to 3 rows, one per channel it actually went out on), across
 * all three feature types, newest first. The "Channel" column shows which
 * channel that specific row delivered on: App, Email, or Push.
 */
export default function AdminNotificationsTab() {
    const [rows, setRows] = useState<NotificationLogEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [q, setQ] = useState('');
    const [type, setType] = useState<NotificationLogType | ''>('');
    const [channel, setChannel] = useState<NotificationLogChannel | ''>('');
    const [mode, setMode] = useState<NotificationLogMode | ''>('');
    const [source, setSource] = useState<NotificationLogSource | ''>('');
    const [offset, setOffset] = useState(0);
    const isMobile = useMediaQuery('(max-width: 639px)');
    const [filtersOpen, setFiltersOpen] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetchAdminNotificationsLog({
                type: type || undefined,
                channel: channel || undefined,
                mode: mode || undefined,
                source: source || undefined,
                q: q.trim() || undefined,
                limit: PAGE_SIZE,
                offset: isMobile ? 0 : offset,
            });
            setRows(res.items);
            setTotal(res.total);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load notifications');
        } finally {
            setLoading(false);
        }
    }, [type, channel, mode, source, q, offset, isMobile]);

    useEffect(() => { load(); }, [load]);

    const loadMore = async () => {
        setLoading(true);
        try {
            const res = await fetchAdminNotificationsLog({
                type: type || undefined,
                channel: channel || undefined,
                mode: mode || undefined,
                source: source || undefined,
                q: q.trim() || undefined,
                limit: PAGE_SIZE,
                offset: rows.length,
            });
            const seen = new Set(rows.map((r) => r.id));
            setRows([...rows, ...res.items.filter((r) => !seen.has(r.id))]);
            setTotal(res.total);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load notifications');
        } finally {
            setLoading(false);
        }
    };

    const filterSelects: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }[] = [
        { label: 'Type', value: type, onChange: (v) => setType(v as NotificationLogType | ''), options: [['', 'Any'], ['interest_match', 'Interest match'], ['activity_digest', 'Activity digest'], ['event_reminder', 'Reminder'], ['review_prompt', 'Review prompt']] },
        { label: 'Channel', value: channel, onChange: (v) => setChannel(v as NotificationLogChannel | ''), options: [['', 'Any'], ['app', 'App'], ['email', 'Email'], ['push', 'Push']] },
        { label: 'Email mode', value: mode, onChange: (v) => setMode(v as NotificationLogMode | ''), options: [['', 'Any'], ['instant', 'Instant'], ['digest', 'Digest']] },
        { label: 'Sent by', value: source, onChange: (v) => setSource(v as NotificationLogSource | ''), options: [['', 'Any'], ['job', 'Delivery job'], ['tick', 'Scheduler tick'], ['admin', 'Admin trigger'], ['request', 'Request']] },
    ];
    const activeFilterCount = filterSelects.filter((f) => f.value !== '').length;

    // Reset pagination whenever a filter changes — avoids landing on an
    // empty page after narrowing the result set.
    useEffect(() => { setOffset(0); }, [type, channel, mode, source]);

    const fmtDateTime = (iso: string): string => {
        try { return new Date(iso).toLocaleString(); } catch { return iso; }
    };

    const recipientLabel = (row: NotificationLogEntry): string => {
        if (row.recipient_display_name && row.recipient_handle) {
            return `${row.recipient_display_name} (@${row.recipient_handle})`;
        }
        if (row.recipient_display_name) return row.recipient_display_name;
        if (row.recipient_handle) return `@${row.recipient_handle}`;
        return row.recipient_email;
    };

    return (
        <section className="space-y-4">
            <header className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">Notifications</h2>
                <span className="text-xs text-ink-soft">
                    {loading ? 'Loading…' : `${total.toLocaleString()} total`}
                </span>
            </header>

            {isMobile && (
                <div className="flex gap-2">
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search recipient"
                        className="min-h-11 min-w-0 flex-1 border border-line px-3 text-base"
                        aria-label="Search notifications by recipient"
                    />
                    <button
                        type="button"
                        onClick={() => setFiltersOpen(true)}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-line bg-surface px-3 text-sm font-medium text-ink"
                    >
                        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                        Filters
                        {activeFilterCount > 0 && (
                            <span className="inline-flex h-5 min-w-5 items-center justify-center bg-action px-1 text-[11px] font-semibold text-white">{activeFilterCount}</span>
                        )}
                    </button>
                </div>
            )}

            {!isMobile && (
                <div className="flex flex-wrap items-center gap-4 text-xs">
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => {
                            setQ(e.target.value);
                            setOffset(0);
                        }}
                        placeholder="Search recipient handle, name, email"
                        className="w-40 border border-line px-2 py-1 text-xs"
                        aria-label="Search notifications by recipient"
                    />
                    <label className="flex items-center gap-1.5">
                        Type
                        <select
                            value={type}
                            onChange={(e) => setType(e.target.value as NotificationLogType | '')}
                            className="border border-line px-2 py-1 text-xs"
                            aria-label="Filter by notification type"
                        >
                            <option value="">Any</option>
                            <option value="interest_match">Interest match</option>
                            <option value="activity_digest">Activity digest</option>
                            <option value="event_reminder">Reminder</option>
                            <option value="review_prompt">Review prompt</option>
                        </select>
                    </label>
                    <label className="flex items-center gap-1.5">
                        Channel
                        <select
                            value={channel}
                            onChange={(e) => setChannel(e.target.value as NotificationLogChannel | '')}
                            className="border border-line px-2 py-1 text-xs"
                            aria-label="Filter by delivery channel"
                        >
                            <option value="">Any</option>
                            <option value="app">App</option>
                            <option value="email">Email</option>
                            <option value="push">Push</option>
                        </select>
                    </label>
                    <label className="flex items-center gap-1.5">
                        Email mode
                        <select
                            value={mode}
                            onChange={(e) => setMode(e.target.value as NotificationLogMode | '')}
                            className="border border-line px-2 py-1 text-xs"
                            aria-label="Filter by email mode"
                        >
                            <option value="">Any</option>
                            <option value="instant">Instant</option>
                            <option value="digest">Digest</option>
                        </select>
                    </label>
                    <label className="flex items-center gap-1.5">
                        Sent by
                        <select
                            value={source}
                            onChange={(e) => setSource(e.target.value as NotificationLogSource | '')}
                            className="border border-line px-2 py-1 text-xs"
                            aria-label="Filter by sender"
                        >
                            <option value="">Any</option>
                            <option value="job">Delivery job</option>
                            <option value="tick">Scheduler tick</option>
                            <option value="admin">Admin trigger</option>
                            <option value="request">Request</option>
                        </select>
                    </label>
                </div>
            )}

            {error && (
                <div className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-danger">
                    {error}
                </div>
            )}

            {isMobile ? (
                <div className="-mx-4">
                    {!loading && rows.length === 0 && (
                        <p className="px-4 py-8 text-center text-sm text-ink-soft">No notifications match these filters.</p>
                    )}
                    <ul className="divide-y divide-line border-y border-line bg-surface">
                        {rows.map((row) => (
                            <li key={row.id} className="space-y-1 px-4 py-3 text-sm">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium text-ink" title={row.kind}>{TYPE_LABELS[row.type] || row.type}</span>
                                    <ChannelBadge channel={row.channel} />
                                    <span className="ml-auto text-xs text-ink-soft">{fmtDateTime(row.delivered_at)}</span>
                                </div>
                                <p className="truncate text-xs text-ink-soft">{recipientLabel(row)}</p>
                                <div className="text-xs"><AboutCell row={row} /></div>
                                <div className="text-xs"><DeliveryCell row={row} /></div>
                            </li>
                        ))}
                    </ul>
                    <AdminLoadMore shown={rows.length} total={total} loading={loading} onLoadMore={loadMore} />
                </div>
            ) : (
                <div className="overflow-x-auto border border-line">
                    <table className="w-full text-xs">
                        <thead className="bg-canvas text-left text-xs uppercase text-ink-soft">
                            <tr>
                                <th className="px-3 py-2">Date/time</th>
                                <th className="px-3 py-2">User</th>
                                <th className="px-3 py-2">Type</th>
                                <th className="px-3 py-2">Channel</th>
                                <th className="px-3 py-2" title="Email mode · sender · time since the notification was created">Delivery</th>
                                <th className="px-3 py-2">About</th>
                            </tr>
                        </thead>
                        <tbody>
                            {!loading && rows.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-3 py-8 text-center text-ink-soft">
                                        No notifications match these filters.
                                    </td>
                                </tr>
                            )}
                            {rows.map((row) => (
                                <tr key={row.id} className="border-t border-line hover:bg-canvas">
                                    <td className="px-3 py-2 text-ink-soft whitespace-nowrap">
                                        {fmtDateTime(row.delivered_at)}
                                    </td>
                                    <td className="px-3 py-2 truncate max-w-[20rem]">
                                        {recipientLabel(row)}
                                    </td>
                                    <td className="px-3 py-2 whitespace-nowrap" title={row.kind}>
                                        {TYPE_LABELS[row.type] || row.type}
                                    </td>
                                    <td className="px-3 py-2">
                                        <ChannelBadge channel={row.channel} />
                                    </td>
                                    <td className="px-3 py-2">
                                        <DeliveryCell row={row} />
                                    </td>
                                    <td className="px-3 py-2">
                                        <AboutCell row={row} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {!isMobile && total > PAGE_SIZE && (
                <div className="flex items-center justify-between text-xs">
                    <button
                        type="button"
                        disabled={offset === 0 || loading}
                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                        className="px-2 py-1 border border-line bg-surface hover:bg-canvas disabled:opacity-40"
                    >
                        ← Previous
                    </button>
                    <span className="text-ink-soft">
                        {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
                    </span>
                    <button
                        type="button"
                        disabled={offset + PAGE_SIZE >= total || loading}
                        onClick={() => setOffset(offset + PAGE_SIZE)}
                        className="px-2 py-1 border border-line bg-surface hover:bg-canvas disabled:opacity-40"
                    >
                        Next →
                    </button>
                </div>
            )}
            {isMobile && filtersOpen && (
                <BottomSheet
                    title="Filters"
                    onClose={() => setFiltersOpen(false)}
                    headerAction={activeFilterCount > 0 ? (
                        <button type="button" onClick={() => filterSelects.forEach((f) => f.onChange(''))} className="min-h-11 px-2 text-sm font-medium text-action">Reset</button>
                    ) : undefined}
                    footer={
                        <button type="button" onClick={() => setFiltersOpen(false)} className="min-h-11 w-full bg-action text-sm font-semibold text-white hover:opacity-90">
                            {loading ? 'Loading…' : `Show ${total.toLocaleString()} result${total === 1 ? '' : 's'}`}
                        </button>
                    }
                >
                    <div className="space-y-4 pb-2">
                        {filterSelects.map((f) => (
                            <label key={f.label} className="block space-y-1">
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{f.label}</span>
                                <select
                                    value={f.value}
                                    onChange={(e) => f.onChange(e.target.value)}
                                    className="min-h-11 w-full border border-line bg-surface px-3 text-base text-ink"
                                >
                                    {f.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                                </select>
                            </label>
                        ))}
                    </div>
                </BottomSheet>
            )}
        </section>
    );
}
