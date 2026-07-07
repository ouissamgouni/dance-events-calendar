import { useCallback, useEffect, useState } from 'react';
import {
    fetchAdminUsers,
    adminDeleteUser,
    adminBlockUser,
    adminRevokeUserBlock,
    adminSetVerifiedOrganizer,
    adminSetAdminManaged,
    adminSetForceInstallPrompt,
    adminMergeUsers,
} from '../api';
import type { AdminUserMergeResponse, AdminUserRow } from '../api';
import { ConfirmDialog, PromptDialog } from './AppDialog';
import { FeatureStatusCell, PushSubscriptionCell } from './NotificationStatusBadges';

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
    const [includeDeleted, setIncludeDeleted] = useState(false);
    const [verifiedOnly, setVerifiedOnly] = useState(false);
    const [offset, setOffset] = useState(0);
    const [busyUserId, setBusyUserId] = useState<string | null>(null);
    const [managedPrompt, setManagedPrompt] = useState<{ row: AdminUserRow; mode: 'manage' | 'label' } | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<AdminUserRow | null>(null);
    const [blockPrompt, setBlockPrompt] = useState<AdminUserRow | null>(null);
    const [unblockTarget, setUnblockTarget] = useState<AdminUserRow | null>(null);
    const [mergeTarget, setMergeTarget] = useState<AdminUserRow | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetchAdminUsers({
                q: q.trim() || undefined,
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
    }, [q, includeDeleted, verifiedOnly, offset]);

    useEffect(() => { load(); }, [load]);

    // Reset pagination whenever a filter changes — avoids landing on an
    // empty page after narrowing the result set.
    useEffect(() => { setOffset(0); }, [includeDeleted, verifiedOnly]);

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

    const onToggleForceInstall = async (row: AdminUserRow) => {
        setBusyUserId(row.user_id);
        try {
            await adminSetForceInstallPrompt(row.user_id, !row.force_install_prompt);
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

    const onMerge = async (source: AdminUserRow, destinationUserId: string, reason: string | null) => {
        setMergeTarget(null);
        setBusyUserId(source.user_id);
        try {
            const res = await adminMergeUsers(source.user_id, destinationUserId, reason);
            setNotice(mergeNotice(source, rows, res));
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to merge users');
        } finally {
            setBusyUserId(null);
        }
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

    const saveBlockPrompt = async (value: string) => {
        const row = blockPrompt;
        if (!row) return;
        setBlockPrompt(null);
        setBusyUserId(row.user_id);
        try {
            await adminBlockUser(row.user_id, value.trim() || null);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to block');
        } finally {
            setBusyUserId(null);
        }
    };

    const confirmUnblock = async () => {
        const row = unblockTarget;
        if (!row?.active_block_id) return;
        setUnblockTarget(null);
        setBusyUserId(row.user_id);
        try {
            await adminRevokeUserBlock(row.active_block_id);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to unblock');
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
                        placeholder="Search handle, name, email"
                        className="w-64 border border-slate-300 px-2 py-1 text-xs"
                        aria-label="Search users"
                    />
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-4 text-xs">
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
                <div className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {error}
                </div>
            )}
            {notice && !error && (
                <div className="border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                    {notice}
                </div>
            )}

            <div className="overflow-x-auto border border-slate-200">
                <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-600">
                        <tr>
                            <th className="px-3 py-2">User</th>
                            <th className="px-3 py-2">Email</th>
                            <th className="px-3 py-2">Created</th>
                            <th className="px-3 py-2 text-right">Followers</th>
                            <th className="px-3 py-2 text-right">Following</th>
                            <th className="px-3 py-2">Interest-match</th>
                            <th className="px-3 py-2">Reminders</th>
                            <th className="px-3 py-2">Digest</th>
                            <th className="px-3 py-2">Push</th>
                            <th className="px-3 py-2">Installed app</th>
                            <th className="px-3 py-2">Status</th>
                            <th className="px-3 py-2">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={12} className="px-3 py-8 text-center text-slate-500">
                                    No users match these filters.
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => {
                            const isDeleted = row.deleted_at !== null;
                            const isBlocked = row.active_block_id !== null;
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
                                        <FeatureStatusCell
                                            label="Interest-match"
                                            email={row.email_interest_matches_enabled}
                                            push={row.push_interest_matches_enabled}
                                        />
                                    </td>
                                    <td className="px-3 py-2">
                                        <FeatureStatusCell
                                            label="Event reminders"
                                            email={row.email_event_reminders_enabled}
                                            push={row.push_event_reminders_enabled}
                                        />
                                    </td>
                                    <td className="px-3 py-2">
                                        <FeatureStatusCell
                                            label="Activity digest"
                                            email={row.email_social_activity_enabled}
                                            push={row.push_social_activity_enabled}
                                        />
                                    </td>
                                    <td className="px-3 py-2">
                                        <PushSubscriptionCell on={row.has_push_subscription} />
                                    </td>
                                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                                        {row.installed_at ? (
                                            <span title={`Installed ${fmtDate(row.installed_at)}`}>
                                                {fmtDate(row.installed_at)}
                                            </span>
                                        ) : (
                                            <span className="text-slate-400">Not installed</span>
                                        )}
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
                                            {isBlocked && (
                                                <span
                                                    className="px-1.5 py-px text-xs bg-red-50 text-red-700 border border-red-200"
                                                    title={row.blocked_at ? `Blocked ${fmtDate(row.blocked_at)}` : 'Blocked from signing in'}
                                                >
                                                    blocked
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
                                            {row.is_admin_managed && (
                                                <button
                                                    type="button"
                                                    disabled={isDeleted || row.is_admin || busyUserId === row.user_id}
                                                    onClick={() => setMergeTarget(row)}
                                                    className="px-2 py-1 text-xs border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title="Merge this managed account into another user"
                                                >
                                                    Merge
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                disabled={isDeleted || busyUserId === row.user_id}
                                                onClick={() => onToggleForceInstall(row)}
                                                className="px-2 py-1 text-xs border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                title={row.force_install_prompt ? 'Stop forcing the install-app banner (normal 14-day snooze applies)' : "Force-show the install-app banner, bypassing this user's 14-day dismiss snooze"}
                                            >
                                                {row.force_install_prompt ? 'Unforce install' : 'Force install'}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={isDeleted || row.is_admin || busyUserId === row.user_id}
                                                onClick={() => onDelete(row)}
                                                className="px-2 py-1 text-xs border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                title={row.is_admin ? "Can't delete the admin from here" : 'Delete this account'}
                                            >
                                                Delete
                                            </button>
                                            {isBlocked ? (
                                                <button
                                                    type="button"
                                                    disabled={busyUserId === row.user_id}
                                                    onClick={() => setUnblockTarget(row)}
                                                    className="px-2 py-1 text-xs border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title="Allow this account to sign in again"
                                                >
                                                    Unblock
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    disabled={isDeleted || row.is_admin || busyUserId === row.user_id}
                                                    onClick={() => setBlockPrompt(row)}
                                                    className="px-2 py-1 text-xs border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title={row.is_admin ? "Can't block the admin from here" : 'Block this account from signing in'}
                                                >
                                                    Block
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
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
            <PromptDialog
                open={blockPrompt !== null}
                title="Block User"
                message={`Block ${userLabel(blockPrompt)} from signing in again. Optional internal reason.`}
                initialValue=""
                placeholder="Reason for block"
                maxLength={240}
                confirmLabel="Block"
                destructive
                onCancel={() => setBlockPrompt(null)}
                onConfirm={(value) => void saveBlockPrompt(value)}
            />
            <ConfirmDialog
                open={unblockTarget !== null}
                title="Unblock User"
                message={`Allow ${userLabel(unblockTarget)} to sign in again?`}
                confirmLabel="Unblock"
                onCancel={() => setUnblockTarget(null)}
                onConfirm={() => void confirmUnblock()}
            />
            <MergeUsersDialog
                open={mergeTarget !== null}
                source={mergeTarget}
                onCancel={() => setMergeTarget(null)}
                onConfirm={(destinationUserId, reason) => {
                    if (mergeTarget) void onMerge(mergeTarget, destinationUserId, reason);
                }}
            />
        </section>
    );
}

function mergeNotice(source: AdminUserRow, rows: AdminUserRow[], res: AdminUserMergeResponse): string {
    const destination = rows.find((row) => row.user_id === res.destination_user_id);
    const count = Object.values(res.summary).reduce((total, value) => total + value, 0);
    return `Merged ${userDisplay(source)} into ${userDisplay(destination ?? null)}. ${count} rows updated, deduped, or anonymized.`;
}

function userDisplay(row: AdminUserRow | null): string {
    if (!row) return 'the destination user';
    if (row.display_name && row.handle) return `${row.display_name} (@${row.handle})`;
    if (row.display_name) return row.display_name;
    if (row.handle) return `@${row.handle}`;
    return row.email;
}

function MergeUsersDialog({
    open,
    source,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    source: AdminUserRow | null;
    onCancel: () => void;
    onConfirm: (destinationUserId: string, reason: string | null) => void;
}) {
    const [query, setQuery] = useState('');
    const [candidates, setCandidates] = useState<AdminUserRow[]>([]);
    const [destinationUserId, setDestinationUserId] = useState('');
    const [reason, setReason] = useState('');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setQuery('');
        setCandidates([]);
        setDestinationUserId('');
        setReason('');
        setFieldError(null);
        setSearchError(null);
    }, [open, source?.user_id]);

    useEffect(() => {
        if (!open || !source) return;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            setSearching(true);
            setSearchError(null);
            void fetchAdminUsers({
                q: query.trim() || undefined,
                limit: 20,
                offset: 0,
            })
                .then((res) => {
                    if (cancelled) return;
                    const next = res.items.filter((row) => row.user_id !== source.user_id && !row.is_admin && row.deleted_at === null);
                    setCandidates(next);
                    if (destinationUserId && !next.some((row) => row.user_id === destinationUserId)) {
                        setDestinationUserId('');
                    }
                })
                .catch((e) => {
                    if (cancelled) return;
                    setSearchError(e instanceof Error ? e.message : 'Failed to search users');
                })
                .finally(() => {
                    if (!cancelled) setSearching(false);
                });
        }, 250);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [destinationUserId, open, query, source]);

    if (!open || !source) return null;
    const destination = candidates.find((row) => row.user_id === destinationUserId) ?? null;

    return (
        <div className="fixed inset-0 z-[11000] flex items-center justify-center bg-slate-900/40 p-4" onClick={onCancel}>
            <form
                role="dialog"
                aria-modal="true"
                aria-labelledby="admin-merge-title"
                className="w-full max-w-lg border border-slate-200 bg-white shadow-xl"
                onClick={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!destinationUserId) {
                        setFieldError('Choose a destination user.');
                        return;
                    }
                    onConfirm(destinationUserId, reason.trim() || null);
                }}
            >
                <div className="border-b border-slate-100 px-4 py-3">
                    <h2 id="admin-merge-title" className="text-sm font-semibold text-slate-900">Merge Managed User</h2>
                </div>
                <div className="space-y-4 px-4 py-3 text-sm text-slate-700">
                    <div className="border border-red-200 bg-red-50 px-3 py-2 text-red-800">
                        {userDisplay(source)} will be soft-deleted after its data is moved. The destination user keeps their email, Google sign-in, handle, name, and avatar.
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="merge-destination-search" className="block font-medium text-slate-800">Search destination user</label>
                        <input
                            id="merge-destination-search"
                            type="search"
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                setFieldError(null);
                            }}
                            className="w-full border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            placeholder="Search email, handle, or name"
                            autoFocus
                        />
                        <div className="max-h-44 overflow-y-auto border border-slate-200 bg-white">
                            {searching && (
                                <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
                            )}
                            {!searching && candidates.length === 0 && (
                                <div className="px-3 py-2 text-xs text-slate-500">No active non-admin users found.</div>
                            )}
                            {!searching && candidates.map((row) => {
                                const selected = row.user_id === destinationUserId;
                                return (
                                    <button
                                        key={row.user_id}
                                        type="button"
                                        onClick={() => {
                                            setDestinationUserId(row.user_id);
                                            setFieldError(null);
                                        }}
                                        className={selected
                                            ? 'block w-full border-b border-slate-100 bg-blue-500 px-3 py-2 text-left text-xs text-white last:border-b-0'
                                            : 'block w-full border-b border-slate-100 bg-white px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50 last:border-b-0'}
                                    >
                                        <span className="block font-medium">{userDisplay(row)}</span>
                                        <span className={selected ? 'block text-blue-50' : 'block text-slate-500'}>{row.email}</span>
                                    </button>
                                );
                            })}
                        </div>
                        {fieldError && <p className="text-xs text-red-700">{fieldError}</p>}
                        {searchError && <p className="text-xs text-red-700">{searchError}</p>}
                    </div>
                    <div className="grid gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:grid-cols-2">
                        <div>
                            <div className="font-medium text-slate-800">Source</div>
                            <div>{userDisplay(source)}</div>
                            <div>{source.email}</div>
                        </div>
                        <div>
                            <div className="font-medium text-slate-800">Destination</div>
                            <div>{userDisplay(destination)}</div>
                            <div>{destination?.email ?? 'Choose a user'}</div>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="merge-reason" className="block font-medium text-slate-800">Internal reason</label>
                        <textarea
                            id="merge-reason"
                            value={reason}
                            maxLength={500}
                            onChange={(e) => setReason(e.target.value)}
                            className="min-h-20 w-full border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            placeholder="Blocked Google account recovery"
                        />
                    </div>
                </div>
                <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!destinationUserId}
                        className="bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Merge
                    </button>
                </div>
            </form>
        </div>
    );
}
