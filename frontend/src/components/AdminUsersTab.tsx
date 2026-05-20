import { useCallback, useEffect, useState } from 'react';
import {
    fetchAdminUsers,
    adminDeleteUser,
    adminSetVerifiedOrganizer,
    adminSetAdminManaged,
} from '../api';
import type { AdminUserRow } from '../api';

const PAGE_SIZE = 50;

/**
 * Admin Users tab.
 *
 * Surfaces every account (including soft-deleted on demand) so the admin can
 * search by handle / display name / email, toggle the verified-organizer
 * badge, and hard-delete an account when needed. The same purge helper backs
 * both this delete and the user-facing ``DELETE /api/auth/me`` so social
 * edges (follows, subscriptions) are always cleaned up consistently.
 *
 * Privacy: the underlying ``GET /api/social/admin/users`` is gated by
 * ``require_admin`` so emails are intentionally exposed here — they are
 * essential for support workflows ("a user emailed us about X") and are
 * never reachable via any public profile route.
 */
export default function AdminUsersTab() {
    const [rows, setRows] = useState<AdminUserRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [q, setQ] = useState('');
    const [appliedQ, setAppliedQ] = useState('');
    const [includeDeleted, setIncludeDeleted] = useState(false);
    const [verifiedOnly, setVerifiedOnly] = useState(false);
    const [offset, setOffset] = useState(0);
    const [busyHandle, setBusyHandle] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetchAdminUsers({
                q: appliedQ || undefined,
                includeDeleted,
                verifiedOnly,
                limit: PAGE_SIZE,
                offset,
            });
            setRows(res.items);
            setTotal(res.total);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load users');
        } finally {
            setLoading(false);
        }
    }, [appliedQ, includeDeleted, verifiedOnly, offset]);

    useEffect(() => { load(); }, [load]);

    // Reset pagination whenever a filter changes — avoids landing on an
    // empty page after narrowing the result set.
    useEffect(() => { setOffset(0); }, [appliedQ, includeDeleted, verifiedOnly]);

    const onSearchSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setAppliedQ(q.trim());
    };

    const onToggleVerified = async (row: AdminUserRow) => {
        if (!row.handle) return;
        setBusyHandle(row.handle);
        try {
            await adminSetVerifiedOrganizer(row.handle, !row.is_verified_organizer);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update');
        } finally {
            setBusyHandle(null);
        }
    };

    const onToggleManaged = async (row: AdminUserRow) => {
        if (!row.handle) return;
        // When flipping ON we also ask for an optional label so the
        // admin can disambiguate curator personas in the list.
        let nextLabel: string | null = row.managed_label;
        if (!row.is_admin_managed) {
            const input = window.prompt(
                `Mark @${row.handle} as admin-managed.\n\nOptional internal label (e.g. "Salsa Nights Paris"). Leave blank to skip.`,
                row.managed_label ?? '',
            );
            if (input === null) return; // cancelled
            nextLabel = input.trim() || null;
        }
        setBusyHandle(row.handle);
        try {
            await adminSetAdminManaged(row.handle, !row.is_admin_managed, nextLabel);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update');
        } finally {
            setBusyHandle(null);
        }
    };

    const onEditManagedLabel = async (row: AdminUserRow) => {
        if (!row.handle || !row.is_admin_managed) return;
        const input = window.prompt(
            `Internal label for @${row.handle} (max 120 chars). Leave blank to clear.`,
            row.managed_label ?? '',
        );
        if (input === null) return;
        const next = input.trim() || null;
        setBusyHandle(row.handle);
        try {
            await adminSetAdminManaged(row.handle, true, next);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update');
        } finally {
            setBusyHandle(null);
        }
    };

    const onDelete = async (row: AdminUserRow) => {
        if (!row.handle) return;
        const label = row.display_name || row.handle;
        const ok = window.confirm(
            `Delete ${label} (@${row.handle})?\n\nThis purges saved events, attendance, follows, and subscriptions, then anonymises the account. Reviews are kept (anonymised). This cannot be undone.`,
        );
        if (!ok) return;
        setBusyHandle(row.handle);
        try {
            await adminDeleteUser(row.handle);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to delete');
        } finally {
            setBusyHandle(null);
        }
    };

    const fmtDate = (iso: string | null): string => {
        if (!iso) return '—';
        try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
    };

    return (
        <section className="space-y-4">
            <header className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">Users</h2>
                <span className="text-sm text-slate-500">
                    {loading ? 'Loading…' : `${total.toLocaleString()} total`}
                </span>
                <form onSubmit={onSearchSubmit} className="flex items-center gap-2 ml-auto">
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search handle, name, email"
                        className="px-2 py-1 border border-slate-300 rounded text-sm w-64"
                        aria-label="Search users"
                    />
                    <button
                        type="submit"
                        className="px-2 py-1 border border-slate-300 bg-white text-sm rounded hover:bg-slate-50"
                    >
                        Search
                    </button>
                </form>
            </header>

            <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                    <input
                        type="checkbox"
                        checked={includeDeleted}
                        onChange={(e) => setIncludeDeleted(e.target.checked)}
                    />
                    Include deleted
                </label>
                <label className="flex items-center gap-1.5">
                    <input
                        type="checkbox"
                        checked={verifiedOnly}
                        onChange={(e) => setVerifiedOnly(e.target.checked)}
                    />
                    Verified organizers only
                </label>
            </div>

            {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
                    {error}
                </div>
            )}

            <div className="overflow-x-auto border border-slate-200 rounded">
                <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-600">
                        <tr>
                            <th className="px-3 py-2">User</th>
                            <th className="px-3 py-2">Email</th>
                            <th className="px-3 py-2">Created</th>
                            <th className="px-3 py-2 text-right">Followers</th>
                            <th className="px-3 py-2 text-right">Following</th>
                            <th className="px-3 py-2">Status</th>
                            <th className="px-3 py-2">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                                    No users match these filters.
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => {
                            const isDeleted = row.deleted_at !== null;
                            return (
                                <tr key={row.user_id} className="border-t border-slate-200 hover:bg-slate-50">
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            {row.avatar_url ? (
                                                <img src={row.avatar_url} alt="" className="w-7 h-7 rounded-full" />
                                            ) : (
                                                <div className="w-7 h-7 rounded-full bg-slate-200" aria-hidden />
                                            )}
                                            <div className="min-w-0">
                                                <div className="truncate font-medium">
                                                    {row.display_name || '—'}
                                                </div>
                                                <div className="text-xs text-slate-500 truncate">
                                                    {row.handle ? `@${row.handle}` : '(no handle)'}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 text-slate-700 truncate max-w-[16rem]">
                                        {row.email}
                                    </td>
                                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                                        {fmtDate(row.created_at)}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {row.followers_count}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {row.following_count}
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex flex-wrap items-center gap-1">
                                            {row.is_admin && (
                                                <span className="px-1.5 py-px text-xs bg-amber-100 text-amber-800 rounded">
                                                    admin
                                                </span>
                                            )}
                                            {row.is_verified_organizer && (
                                                <span className="px-1.5 py-px text-xs bg-emerald-100 text-emerald-800 rounded">
                                                    verified
                                                </span>
                                            )}
                                            {row.is_admin_managed && (
                                                <span
                                                    className="px-1.5 py-px text-xs bg-indigo-100 text-indigo-800 rounded"
                                                    title={row.managed_label || 'Admin-managed curator account'}
                                                >
                                                    managed{row.managed_label ? `: ${row.managed_label}` : ''}
                                                </span>
                                            )}
                                            {isDeleted && (
                                                <span className="px-1.5 py-px text-xs bg-slate-200 text-slate-700 rounded">
                                                    deleted
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                type="button"
                                                disabled={!row.handle || isDeleted || busyHandle === row.handle}
                                                onClick={() => onToggleVerified(row)}
                                                className="px-2 py-1 text-xs border border-slate-300 bg-white rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                title={row.is_verified_organizer ? 'Remove verified badge' : 'Mark as verified organizer'}
                                            >
                                                {row.is_verified_organizer ? 'Unverify' : 'Verify'}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={!row.handle || isDeleted || row.is_admin || busyHandle === row.handle}
                                                onClick={() => onToggleManaged(row)}
                                                className="px-2 py-1 text-xs border border-slate-300 bg-white rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                title={row.is_admin_managed ? 'Unmark as admin-managed account' : 'Mark as admin-managed curator account'}
                                            >
                                                {row.is_admin_managed ? 'Unmanage' : 'Manage'}
                                            </button>
                                            {row.is_admin_managed && (
                                                <button
                                                    type="button"
                                                    disabled={!row.handle || isDeleted || busyHandle === row.handle}
                                                    onClick={() => onEditManagedLabel(row)}
                                                    className="px-2 py-1 text-xs border border-slate-300 bg-white rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title="Edit internal managed label"
                                                >
                                                    Label
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                disabled={!row.handle || isDeleted || row.is_admin || busyHandle === row.handle}
                                                onClick={() => onDelete(row)}
                                                className="px-2 py-1 text-xs border border-red-300 text-red-700 bg-white rounded hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                title={row.is_admin ? "Can't delete the admin from here" : 'Delete this account'}
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {total > PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm">
                    <button
                        type="button"
                        disabled={offset === 0 || loading}
                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                        className="px-2 py-1 border border-slate-300 bg-white rounded hover:bg-slate-50 disabled:opacity-40"
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
                        className="px-2 py-1 border border-slate-300 bg-white rounded hover:bg-slate-50 disabled:opacity-40"
                    >
                        Next →
                    </button>
                </div>
            )}
        </section>
    );
}
