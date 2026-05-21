import { useCallback, useEffect, useState } from 'react';
import {
    fetchAdminUsers,
    adminDeleteUser,
    adminSetVerifiedOrganizer,
    adminSetAdminManaged,
} from '../api';
import type { AdminUserRow } from '../api';
import { ConfirmDialog, PromptDialog } from './AppDialog';

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
    const [busyUserId, setBusyUserId] = useState<string | null>(null);
    const [managedPrompt, setManagedPrompt] = useState<{ row: AdminUserRow; mode: 'manage' | 'label' } | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<AdminUserRow | null>(null);

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
        setBusyUserId(row.user_id);
        try {
            await adminSetVerifiedOrganizer(row.user_id, !row.is_verified_organizer);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update');
        } finally {
            setBusyUserId(null);
        }
    };

    const onToggleManaged = async (row: AdminUserRow) => {
        if (!row.is_admin_managed) {
            setManagedPrompt({ row, mode: 'manage' });
            return;
        }
        setBusyUserId(row.user_id);
        try {
            await adminSetAdminManaged(row.user_id, false, row.managed_label);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update');
        } finally {
            setBusyUserId(null);
        }
    };

    const onEditManagedLabel = async (row: AdminUserRow) => {
        if (!row.is_admin_managed) return;
        setManagedPrompt({ row, mode: 'label' });
    };

    const saveManagedPrompt = async (value: string) => {
        const userId = managedPrompt?.row.user_id;
        if (!userId) return;
        const { mode } = managedPrompt;
        const next = value.trim() || null;
        setManagedPrompt(null);
        setBusyUserId(userId);
        try {
            await adminSetAdminManaged(userId, true, next);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : mode === 'manage' ? 'Failed to manage user' : 'Failed to update');
        } finally {
            setBusyUserId(null);
        }
    };

    const onDelete = async (row: AdminUserRow) => {
        setDeleteTarget(row);
    };

    const confirmDelete = async () => {
        const row = deleteTarget;
        if (!row) return;
        setDeleteTarget(null);
        setBusyUserId(row.user_id);
        try {
            await adminDeleteUser(row.user_id);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to delete');
        } finally {
            setBusyUserId(null);
        }
    };

    const userLabel = (row: AdminUserRow | null): string => {
        if (!row) return 'this user';
        if (row.display_name && row.handle) return `${row.display_name} (@${row.handle})`;
        if (row.display_name) return row.display_name;
        if (row.handle) return `@${row.handle}`;
        return row.email;
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
                        className="px-2 py-1 border border-slate-300 text-sm w-64"
                        aria-label="Search users"
                    />
                    <button
                        type="submit"
                        className="px-2 py-1 border border-slate-300 bg-white text-sm hover:bg-slate-50"
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
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2">
                    {error}
                </div>
            )}

            <div className="overflow-x-auto border border-slate-200">
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
                                                <span className="px-1.5 py-px text-xs bg-amber-100 text-amber-800">
                                                    admin
                                                </span>
                                            )}
                                            {row.is_verified_organizer && (
                                                <span className="px-1.5 py-px text-xs bg-emerald-100 text-emerald-800">
                                                    verified
                                                </span>
                                            )}
                                            {row.is_admin_managed && (
                                                <span
                                                    className="px-1.5 py-px text-xs bg-blue-50 text-blue-700 border border-blue-200"
                                                    title={row.managed_label || 'Admin-managed curator account'}
                                                >
                                                    managed{row.managed_label ? `: ${row.managed_label}` : ''}
                                                </span>
                                            )}
                                            {isDeleted && (
                                                <span className="px-1.5 py-px text-xs bg-slate-200 text-slate-700">
                                                    deleted
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                type="button"
                                                disabled={isDeleted || busyUserId === row.user_id}
                                                onClick={() => onToggleVerified(row)}
                                                className="px-2 py-1 text-xs border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                title={row.is_verified_organizer ? 'Remove verified badge' : 'Mark as verified organizer'}
                                            >
                                                {row.is_verified_organizer ? 'Unverify' : 'Verify'}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={isDeleted || row.is_admin || busyUserId === row.user_id}
                                                onClick={() => onToggleManaged(row)}
                                                className="px-2 py-1 text-xs border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                title={row.is_admin_managed ? 'Unmark as admin-managed account' : 'Mark as admin-managed curator account'}
                                            >
                                                {row.is_admin_managed ? 'Unmanage' : 'Manage'}
                                            </button>
                                            {row.is_admin_managed && (
                                                <button
                                                    type="button"
                                                    disabled={isDeleted || busyUserId === row.user_id}
                                                    onClick={() => onEditManagedLabel(row)}
                                                    className="px-2 py-1 text-xs border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title="Edit internal managed label"
                                                >
                                                    Label
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                disabled={isDeleted || row.is_admin || busyUserId === row.user_id}
                                                onClick={() => onDelete(row)}
                                                className="px-2 py-1 text-xs border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
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

            <PromptDialog
                open={managedPrompt !== null}
                title={managedPrompt?.mode === 'manage' ? 'Manage Curator Account' : 'Edit Curator Label'}
                message={managedPrompt?.mode === 'manage'
                    ? `Mark ${userLabel(managedPrompt.row)} as admin-managed. Optional internal label.`
                    : `Internal label for ${userLabel(managedPrompt?.row ?? null)}. Leave blank to clear.`}
                initialValue={managedPrompt?.row.managed_label ?? ''}
                placeholder="Paris Salsa Curator"
                maxLength={120}
                confirmLabel={managedPrompt?.mode === 'manage' ? 'Manage' : 'Save'}
                onCancel={() => setManagedPrompt(null)}
                onConfirm={(value) => void saveManagedPrompt(value)}
            />
            <ConfirmDialog
                open={deleteTarget !== null}
                title="Delete User"
                message={`Delete ${userLabel(deleteTarget)}?\n\nThis purges saved events, attendance, follows, and subscriptions, then anonymises the account. Reviews are kept anonymised. This cannot be undone.`}
                confirmLabel="Delete"
                destructive
                onCancel={() => setDeleteTarget(null)}
                onConfirm={() => void confirmDelete()}
            />
        </section>
    );
}
