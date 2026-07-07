/**
 * Button-triggered multi-user picker for admin manual-override actions
 * (force-send interest matches, send digest now). Clicking "Target users"
 * opens a modal listing all users — debounced search over
 * `GET /api/social/admin/users` (has `user_id` + `email`, unlike the public
 * `searchUsers` endpoint) — with checkboxes for multi-select. Selected users
 * are shown as removable chips under the button.
 */
import { useEffect, useState } from 'react';
import { fetchAdminUsers, type AdminUserRow } from '../api';
import { FeatureStatusCell, PushSubscriptionCell } from './NotificationStatusBadges';

interface Props {
    selected: AdminUserRow[];
    onChange: (rows: AdminUserRow[]) => void;
    placeholder?: string;
    buttonLabel?: string;
}

function useDebounced<T>(value: T, ms: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return debounced;
}

export default function AdminUserMultiPicker({ selected, onChange, placeholder, buttonLabel }: Props) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const debouncedQ = useDebounced(q, 250);
    const [results, setResults] = useState<AdminUserRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [staged, setStaged] = useState<AdminUserRow[]>(selected);

    // Re-seed the staged selection each time the modal opens so cancelling
    // discards any in-progress changes.
    useEffect(() => {
        if (!open) return;
        setStaged(selected);
        setQ('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        fetchAdminUsers({ q: debouncedQ.trim() || undefined, limit: 100 })
            .then((res) => { if (!cancelled) setResults(res.items); })
            .catch(() => { if (!cancelled) setResults([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open, debouncedQ]);

    const toggleStaged = (row: AdminUserRow) => {
        setStaged((prev) =>
            prev.some((r) => r.user_id === row.user_id)
                ? prev.filter((r) => r.user_id !== row.user_id)
                : [...prev, row],
        );
    };

    const removeSelected = (userId: string) => {
        onChange(selected.filter((r) => r.user_id !== userId));
    };

    const applyStaged = () => {
        onChange(staged);
        setOpen(false);
    };

    return (
        <div className="space-y-1.5">
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="text-[11px] px-2.5 py-1 border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            >
                {buttonLabel ?? 'Target users'}{selected.length ? ` (${selected.length})` : ''}
            </button>

            {selected.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {selected.map((row) => (
                        <span
                            key={row.user_id}
                            className="inline-flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full pl-2 pr-1 py-0.5"
                        >
                            {row.email}
                            <button
                                type="button"
                                onClick={() => removeSelected(row.user_id)}
                                aria-label={`Remove ${row.email}`}
                                className="text-emerald-500 hover:text-emerald-800"
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                    <div className="w-full max-w-2xl max-h-[80vh] flex flex-col border border-gray-200 bg-white shadow-lg">
                        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
                            <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">
                                Select target users
                            </span>
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                aria-label="Close"
                                className="text-gray-400 hover:text-gray-700 text-sm leading-none"
                            >
                                ×
                            </button>
                        </div>
                        <div className="px-3 py-2 border-b border-gray-100">
                            <input
                                type="text"
                                autoFocus
                                value={q}
                                onChange={(e) => setQ(e.target.value)}
                                placeholder={placeholder ?? 'Search email, handle, or name'}
                                className="w-full text-[11px] border border-gray-200 px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                            />
                        </div>
                        <div className="flex-1 overflow-y-auto overflow-x-auto px-1 py-1">
                            {loading && (
                                <div className="px-2 py-1 text-[10px] text-gray-400">Loading…</div>
                            )}
                            {!loading && results.length === 0 && (
                                <div className="px-2 py-1 text-[10px] text-gray-400">No users found</div>
                            )}
                            {!loading && results.length > 0 && (
                                <table className="w-full text-[11px]">
                                    <thead className="text-left text-[10px] uppercase text-gray-400">
                                        <tr>
                                            <th className="px-2 py-1 w-6" />
                                            <th className="px-2 py-1">User</th>
                                            <th className="px-2 py-1">Interest-match</th>
                                            <th className="px-2 py-1">Reminders</th>
                                            <th className="px-2 py-1">Digest</th>
                                            <th className="px-2 py-1">Push</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {results.map((row) => {
                                            const checked = staged.some((r) => r.user_id === row.user_id);
                                            return (
                                                <tr
                                                    key={row.user_id}
                                                    onClick={() => toggleStaged(row)}
                                                    className="border-t border-gray-50 hover:bg-emerald-50 cursor-pointer"
                                                >
                                                    <td className="px-2 py-1">
                                                        <input
                                                            type="checkbox"
                                                            checked={checked}
                                                            onChange={() => toggleStaged(row)}
                                                            onClick={(e) => e.stopPropagation()}
                                                            aria-label={`Select ${row.email}`}
                                                            className="h-3.5 w-3.5"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        {row.email}
                                                        {row.handle && <span className="text-gray-400"> · @{row.handle}</span>}
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        <FeatureStatusCell
                                                            label="Interest-match"
                                                            email={row.email_interest_matches_enabled}
                                                            push={row.push_interest_matches_enabled}
                                                        />
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        <FeatureStatusCell
                                                            label="Event reminders"
                                                            email={row.email_event_reminders_enabled}
                                                            push={row.push_event_reminders_enabled}
                                                        />
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        <FeatureStatusCell
                                                            label="Activity digest"
                                                            email={row.email_social_activity_enabled}
                                                            push={row.push_social_activity_enabled}
                                                        />
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        <PushSubscriptionCell on={row.has_push_subscription} />
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                        <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100">
                            <span className="text-[10px] text-gray-400">{staged.length} selected</span>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setOpen(false)}
                                    className="text-[11px] px-2.5 py-1 border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={applyStaged}
                                    className="text-[11px] px-2.5 py-1 bg-emerald-600 text-white hover:bg-emerald-700"
                                >
                                    Done
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
