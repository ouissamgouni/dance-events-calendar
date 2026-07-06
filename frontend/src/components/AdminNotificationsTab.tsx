import { useCallback, useEffect, useState } from 'react';
import { fetchAdminNotificationsLog } from '../api';
import type { NotificationLogChannel, NotificationLogEntry, NotificationLogType } from '../api';

const PAGE_SIZE = 50;

const TYPE_LABELS: Record<string, string> = {
    interest_match: 'Interest match',
    activity_digest: 'Activity digest',
    event_reminder: 'Reminder',
};

const CHANNEL_BADGE: Record<string, string> = {
    app: 'inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700',
    email: 'inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700',
    push: 'inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700',
};
const CHANNEL_BADGE_FALLBACK =
    'inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600';
const CHANNEL_LABELS: Record<string, string> = {
    app: 'App',
    email: 'Email',
    push: 'Push',
};

function ChannelBadge({ channel }: { channel: string }) {
    const cls = CHANNEL_BADGE[channel] ?? CHANNEL_BADGE_FALLBACK;
    return <span className={cls}>{CHANNEL_LABELS[channel] ?? channel}</span>;
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
    const [offset, setOffset] = useState(0);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetchAdminNotificationsLog({
                type: type || undefined,
                channel: channel || undefined,
                q: q.trim() || undefined,
                limit: PAGE_SIZE,
                offset,
            });
            setRows(res.items);
            setTotal(res.total);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load notifications');
        } finally {
            setLoading(false);
        }
    }, [type, channel, q, offset]);

    useEffect(() => { load(); }, [load]);

    // Reset pagination whenever a filter changes — avoids landing on an
    // empty page after narrowing the result set.
    useEffect(() => { setOffset(0); }, [type, channel]);

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
                <span className="text-xs text-slate-500">
                    {loading ? 'Loading…' : `${total.toLocaleString()} total`}
                </span>
                <div className="ml-auto">
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => {
                            setQ(e.target.value);
                            setOffset(0);
                        }}
                        placeholder="Search recipient handle, name, email"
                        className="w-64 border border-slate-300 px-2 py-1 text-xs"
                        aria-label="Search notifications by recipient"
                    />
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5">
                    Type
                    <select
                        value={type}
                        onChange={(e) => setType(e.target.value as NotificationLogType | '')}
                        className="border border-slate-300 px-2 py-1 text-xs"
                        aria-label="Filter by notification type"
                    >
                        <option value="">Any</option>
                        <option value="interest_match">Interest match</option>
                        <option value="activity_digest">Activity digest</option>
                        <option value="event_reminder">Reminder</option>
                    </select>
                </label>
                <label className="flex items-center gap-1.5">
                    Channel
                    <select
                        value={channel}
                        onChange={(e) => setChannel(e.target.value as NotificationLogChannel | '')}
                        className="border border-slate-300 px-2 py-1 text-xs"
                        aria-label="Filter by delivery channel"
                    >
                        <option value="">Any</option>
                        <option value="app">App</option>
                        <option value="email">Email</option>
                        <option value="push">Push</option>
                    </select>
                </label>
            </div>

            {error && (
                <div className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {error}
                </div>
            )}

            <div className="overflow-x-auto border border-slate-200">
                <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-600">
                        <tr>
                            <th className="px-3 py-2">Date/time</th>
                            <th className="px-3 py-2">Type</th>
                            <th className="px-3 py-2">Channel</th>
                            <th className="px-3 py-2">User</th>
                        </tr>
                    </thead>
                    <tbody>
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-slate-500">
                                    No notifications match these filters.
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => (
                            <tr key={row.id} className="border-t border-slate-200 hover:bg-slate-50">
                                <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                                    {fmtDateTime(row.delivered_at)}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap" title={row.kind}>
                                    {TYPE_LABELS[row.type] || row.type}
                                </td>
                                <td className="px-3 py-2">
                                    <ChannelBadge channel={row.channel} />
                                </td>
                                <td className="px-3 py-2 truncate max-w-[20rem]">
                                    {recipientLabel(row)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {total > PAGE_SIZE && (
                <div className="flex items-center justify-between text-xs">
                    <button
                        type="button"
                        disabled={offset === 0 || loading}
                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                        className="px-2 py-1 border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40"
                    >
                        ← Previous
                    </button>
                    <span className="text-slate-600">
                        {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
                    </span>
                    <button
                        type="button"
                        disabled={offset + PAGE_SIZE >= total || loading}
                        onClick={() => setOffset(offset + PAGE_SIZE)}
                        className="px-2 py-1 border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40"
                    >
                        Next →
                    </button>
                </div>
            )}
        </section>
    );
}
