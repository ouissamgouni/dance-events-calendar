import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, SlidersHorizontal } from 'lucide-react';
import useBackToClose from '../hooks/useBackToClose';
import useMediaQuery from '../hooks/useMediaQuery';
import BottomSheet from './BottomSheet';
import AdminLoadMore from './AdminLoadMore';
import {
    fetchAdminUsers,
    adminDeleteUser,
    adminBlockUser,
    adminRevokeUserBlock,
    adminSetAdminManaged,
    adminSetForceInstallPrompt,
    adminSetForceEnablePush,
    adminResetOnboarding,
    adminSendInstallEmail,
    adminMergeUsers,
} from '../api';
import type { AdminUserMergeResponse, AdminUserRow } from '../api';
import { ConfirmDialog, PromptDialog } from './AppDialog';
import AdminOrganizerSheet from './AdminOrganizerSheet';
import { FeatureStatusCell, PushSubscriptionCell } from './NotificationStatusBadges';
import { parseUserAgent } from '../utils/userAgent';

const PAGE_SIZE = 50;

type UserActionKey = 'organizer' | 'managed' | 'label' | 'push' | 'install' | 'install-email' | 'onboarding' | 'merge' | 'unblock' | 'block' | 'delete';

type AdminUserSortField =
    | 'created_at'
    | 'last_visit_at'
    | 'followers_count'
    | 'following_count'
    | 'has_push_subscription'
    | 'installed_at';

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
    const [sortBy, setSortBy] = useState<AdminUserSortField>('created_at');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
    const [busyUserId, setBusyUserId] = useState<string | null>(null);
    const [managedPrompt, setManagedPrompt] = useState<{ row: AdminUserRow; mode: 'manage' | 'label' } | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<AdminUserRow | null>(null);
    const [blockPrompt, setBlockPrompt] = useState<AdminUserRow | null>(null);
    const [unblockTarget, setUnblockTarget] = useState<AdminUserRow | null>(null);
    const [mergeTarget, setMergeTarget] = useState<AdminUserRow | null>(null);
    const [organizerTarget, setOrganizerTarget] = useState<AdminUserRow | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const isMobile = useMediaQuery('(max-width: 639px)');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [actionRow, setActionRow] = useState<AdminUserRow | null>(null);
    // Mobile appends pages; reloads refetch everything already loaded.
    const loadedRef = useRef(0);

    const load = useCallback(async (fresh = false) => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetchAdminUsers({
                q: q.trim() || undefined,
                includeDeleted,
                verifiedOnly,
                sortBy,
                sortDir,
                limit: isMobile ? (fresh ? PAGE_SIZE : Math.min(Math.max(loadedRef.current, PAGE_SIZE), 200)) : PAGE_SIZE,
                offset: isMobile ? 0 : offset,
            });
            setRows(res.items);
            loadedRef.current = res.items.length;
            setTotal(res.total);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load users');
        } finally {
            setLoading(false);
        }
    }, [q, includeDeleted, verifiedOnly, sortBy, sortDir, offset, isMobile]);

    useEffect(() => { load(true); }, [load]);

    const loadMore = async () => {
        setLoading(true);
        try {
            const res = await fetchAdminUsers({
                q: q.trim() || undefined,
                includeDeleted,
                verifiedOnly,
                sortBy,
                sortDir,
                limit: PAGE_SIZE,
                offset: loadedRef.current,
            });
            const seen = new Set(rows.map((r) => r.user_id));
            const next = [...rows, ...res.items.filter((r) => !seen.has(r.user_id))];
            setRows(next);
            loadedRef.current = next.length;
            setTotal(res.total);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load users');
        } finally {
            setLoading(false);
        }
    };

    // Reset pagination whenever a filter or sort changes — avoids landing
    // on an empty page after narrowing/reordering the result set.
    useEffect(() => { setOffset(0); }, [includeDeleted, verifiedOnly, sortBy, sortDir]);

    const onSort = (field: AdminUserSortField) => {
        if (sortBy === field) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortBy(field);
            setSortDir('desc');
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

    const onToggleForceEnablePush = async (row: AdminUserRow) => {
        setBusyUserId(row.user_id);
        try {
            await adminSetForceEnablePush(row.user_id, !row.force_enable_push_prompt);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update');
        } finally {
            setBusyUserId(null);
        }
    };

    const onResetOnboarding = async (row: AdminUserRow) => {
        setBusyUserId(row.user_id);
        try {
            await adminResetOnboarding(row.user_id);
            setNotice(`${row.handle ? '@' + row.handle : row.email} will see onboarding again on next visit`);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update');
        } finally {
            setBusyUserId(null);
        }
    };

    const onSendInstallEmail = async (row: AdminUserRow) => {
        setBusyUserId(row.user_id);
        try {
            const res = await adminSendInstallEmail(row.user_id);
            setNotice(
                res.status === 'sent'
                    ? `Install invitation emailed to ${row.email}`
                    : `Could not email ${row.email} — SMTP is not configured`,
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to send install email');
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

    const formatRelative = (iso: string): string => {
        const then = new Date(iso).getTime();
        const now = Date.now();
        const diffSec = Math.max(0, Math.round((now - then) / 1000));
        if (diffSec < 60) return 'just now';
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
        if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
        return new Date(iso).toLocaleDateString();
    };

    const runUserAction = (key: UserActionKey, row: AdminUserRow) => {
        setActionRow(null);
        if (key === 'organizer') setOrganizerTarget(row);
        else if (key === 'managed') void onToggleManaged(row);
        else if (key === 'label') void onEditManagedLabel(row);
        else if (key === 'push') void onToggleForceEnablePush(row);
        else if (key === 'install') void onToggleForceInstall(row);
        else if (key === 'install-email') void onSendInstallEmail(row);
        else if (key === 'onboarding') void onResetOnboarding(row);
        else if (key === 'merge') setMergeTarget(row);
        else if (key === 'unblock') setUnblockTarget(row);
        else if (key === 'block') setBlockPrompt(row);
        else void onDelete(row);
    };

    const sortIndicator = (field: AdminUserSortField) => {
        if (sortBy !== field) return null;
        return <span aria-hidden>{sortDir === 'asc' ? '▲' : '▼'}</span>;
    };

    const sortableTh = (field: AdminUserSortField, label: string, align: 'left' | 'right' = 'left') => (
        <th
            className={`px-3 py-2${align === 'right' ? ' text-right' : ''}`}
            aria-sort={sortBy === field ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        >
            <button
                type="button"
                onClick={() => onSort(field)}
                className={`flex items-center gap-1 uppercase hover:text-ink${align === 'right' ? ' ml-auto' : ''}`}
            >
                {label}
                {sortIndicator(field)}
            </button>
        </th>
    );

    return (
        <section className="space-y-4">
            <header className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">Users</h2>
                <span className="text-xs text-ink-soft">
                    {loading ? 'Loading…' : `${total.toLocaleString()} total`}
                </span>
                <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => {
                            setQ(e.target.value);
                            setOffset(0);
                        }}
                        placeholder="Search handle, name, email"
                        className="min-h-11 min-w-0 flex-1 border border-line px-3 text-base sm:min-h-0 sm:w-64 sm:flex-none sm:px-2 sm:py-1 sm:text-xs"
                        aria-label="Search users"
                    />
                    {isMobile && (
                        <button
                            type="button"
                            onClick={() => setFiltersOpen(true)}
                            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-line bg-surface px-3 text-sm font-medium text-ink"
                        >
                            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                            Filters
                            {Number(includeDeleted) + Number(verifiedOnly) > 0 && (
                                <span className="inline-flex h-5 min-w-5 items-center justify-center bg-action px-1 text-[11px] font-semibold text-white">{Number(includeDeleted) + Number(verifiedOnly)}</span>
                            )}
                        </button>
                    )}
                </div>
            </header>

            {!isMobile && (
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
            )}

            {error && (
                <div className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-danger">
                    {error}
                </div>
            )}
            {notice && !error && (
                <div className="border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-action">
                    {notice}
                </div>
            )}

            {isMobile ? (
                <div className="-mx-4">
                    {!loading && rows.length === 0 && (
                        <p className="px-4 py-8 text-center text-sm text-ink-soft">No users match these filters.</p>
                    )}
                    <ul className="divide-y divide-line border-y border-line bg-surface">
                        {rows.map((row) => (
                            <li key={row.user_id}>
                                <button type="button" onClick={() => setActionRow(row)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas">
                                    {row.avatar_url ? (
                                        // eslint-disable-next-line no-restricted-syntax -- avatar
                                        <img src={row.avatar_url} alt="" className="h-10 w-10 shrink-0 rounded-full" />
                                    ) : (
                                        // eslint-disable-next-line no-restricted-syntax -- avatar
                                        <span className="h-10 w-10 shrink-0 rounded-full bg-slate-200" aria-hidden />
                                    )}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-medium text-ink">
                                            {row.display_name || '—'}
                                            <span className="ml-1 font-normal text-ink-soft">{row.handle ? `@${row.handle}` : ''}</span>
                                        </span>
                                        <span className="block truncate text-xs text-ink-soft">{row.email}</span>
                                        <span className="mt-0.5 block truncate text-xs text-muted">
                                            {row.last_visit_at ? `Seen ${formatRelative(row.last_visit_at)}` : 'Never visited'}
                                            {` · ${row.followers_count} followers · ${row.following_count} following`}
                                        </span>
                                        <UserStatusChips row={row} />
                                    </span>
                                    <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                                </button>
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
                                <th className="px-3 py-2">User</th>
                                <th className="px-3 py-2">Email</th>
                                {sortableTh('last_visit_at', 'Last visit')}
                                {sortableTh('followers_count', 'Followers', 'right')}
                                {sortableTh('following_count', 'Following', 'right')}
                                <th className="px-3 py-2">Interest-match</th>
                                <th className="px-3 py-2">Reminders</th>
                                <th className="px-3 py-2">Digest</th>
                                {sortableTh('has_push_subscription', 'Push')}
                                {sortableTh('installed_at', 'Installed app')}
                                <th className="px-3 py-2">Onboarding</th>
                                <th className="px-3 py-2">Created</th>
                                <th className="px-3 py-2">Status</th>
                                <th className="px-3 py-2">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {!loading && rows.length === 0 && (
                                <tr>
                                    <td colSpan={13} className="px-3 py-8 text-center text-ink-soft">
                                        No users match these filters.
                                    </td>
                                </tr>
                            )}
                            {rows.map((row) => {
                                const isDeleted = row.deleted_at !== null;
                                const isBlocked = row.active_block_id !== null;
                                return (
                                    <tr key={row.user_id} className="border-t border-line hover:bg-canvas">
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
                                                    <div className="text-xs text-ink-soft truncate">
                                                        {row.handle ? `@${row.handle}` : '(no handle)'}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-3 py-2 text-ink truncate max-w-[16rem]">
                                            {row.email}
                                        </td>
                                        <td className="px-3 py-2 text-ink-soft whitespace-nowrap">
                                            {row.last_visit_at ? (() => {
                                                const parsed = parseUserAgent(row.last_visit_user_agent);
                                                const details = [
                                                    `Last visit: ${new Date(row.last_visit_at).toLocaleString()}`,
                                                    `${parsed.browserLabel} on ${parsed.osLabel} (${parsed.device})`,
                                                    row.last_visit_user_agent || '',
                                                ].filter(Boolean).join('\n');
                                                return (
                                                    <div className="flex items-center gap-1" title={details}>
                                                        <span>{formatRelative(row.last_visit_at)}</span>
                                                        {parsed.osIcon && (
                                                            <img src={parsed.osIcon} alt={parsed.osLabel} className="w-4 h-4 shrink-0" />
                                                        )}
                                                        {parsed.browserIcon && (
                                                            <img src={parsed.browserIcon} alt={parsed.browserLabel} className="w-4 h-4 shrink-0" />
                                                        )}
                                                    </div>
                                                );
                                            })() : (
                                                <span className="text-muted">—</span>
                                            )}
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
                                            <div className="flex items-center gap-2">
                                                <PushSubscriptionCell on={row.has_push_subscription} />
                                                <button
                                                    type="button"
                                                    disabled={isDeleted || busyUserId === row.user_id}
                                                    onClick={() => onToggleForceEnablePush(row)}
                                                    className="px-2 py-1 text-xs border border-line bg-surface hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title={row.force_enable_push_prompt ? 'Stop forcing the enable-notifications banner (normal 24h snooze applies)' : "Force-show the enable-notifications banner, bypassing this user's 24h dismiss snooze"}
                                                >
                                                    {row.force_enable_push_prompt ? 'Unforce push' : 'Force push'}
                                                </button>
                                            </div>
                                        </td>
                                        <td className="px-3 py-2 text-ink-soft whitespace-nowrap">
                                            <div className="flex items-center gap-2">
                                                {row.installed_at ? (
                                                    <span title={`Installed ${fmtDate(row.installed_at)}`}>
                                                        {fmtDate(row.installed_at)}
                                                    </span>
                                                ) : (
                                                    <span className="text-muted">Not installed</span>
                                                )}
                                                <button
                                                    type="button"
                                                    disabled={isDeleted || busyUserId === row.user_id}
                                                    onClick={() => onToggleForceInstall(row)}
                                                    className="px-2 py-1 text-xs border border-line bg-surface hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title={row.force_install_prompt ? 'Stop forcing the install-app banner (normal 14-day snooze applies)' : "Force-show the install-app banner, bypassing this user's 14-day dismiss snooze"}
                                                >
                                                    {row.force_install_prompt ? 'Unforce install' : 'Force install'}
                                                </button>
                                                {!row.installed_at && (
                                                    <button
                                                        type="button"
                                                        disabled={isDeleted || busyUserId === row.user_id}
                                                        onClick={() => onSendInstallEmail(row)}
                                                        className="px-2 py-1 text-xs border border-line bg-surface hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
                                                        title="Email this user an invitation to install the app, with a link to the /install page"
                                                    >
                                                        Send install email
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-3 py-2 whitespace-nowrap">
                                            <div className="flex items-center gap-2">
                                                {row.needs_onboarding ? (
                                                    <span className="text-ink-soft" title="Will be sent through onboarding on next visit">
                                                        {row.onboarded_at ? 'Pending (v↑)' : 'Never'}
                                                    </span>
                                                ) : (
                                                    <span
                                                        className="text-success"
                                                        title={`Onboarded ${fmtDate(row.onboarded_at)} (v${row.onboarding_version})`}
                                                    >
                                                        ✓ Done
                                                    </span>
                                                )}
                                                <button
                                                    type="button"
                                                    disabled={isDeleted || busyUserId === row.user_id || row.needs_onboarding}
                                                    onClick={() => onResetOnboarding(row)}
                                                    className="px-2 py-1 text-xs border border-line bg-surface hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title="Force this user back through the onboarding wizard on their next visit. Non-destructive: their saved preferences and follows are kept and the wizard re-opens pre-filled."
                                                >
                                                    Retrigger
                                                </button>
                                            </div>
                                        </td>
                                        <td className="px-3 py-2 text-ink-soft whitespace-nowrap">
                                            {fmtDate(row.created_at)}
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
                                                        className="px-1.5 py-px text-xs bg-blue-50 text-action border border-blue-200"
                                                        title={row.managed_label || 'Admin-managed curator account'}
                                                    >
                                                        managed{row.managed_label ? `: ${row.managed_label}` : ''}
                                                    </span>
                                                )}
                                                {isDeleted && (
                                                    <span className="px-1.5 py-px text-xs bg-slate-200 text-ink">
                                                        deleted
                                                    </span>
                                                )}
                                                {isBlocked && (
                                                    <span
                                                        className="px-1.5 py-px text-xs bg-red-50 text-danger border border-red-200"
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
                                                    onClick={() => setOrganizerTarget(row)}
                                                    className="px-2 py-1 text-xs border border-line bg-surface hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title="Verified badge and organized events"
                                                >
                                                    {row.is_verified_organizer ? 'Organizer ✓' : 'Organizer'}
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={isDeleted || row.is_admin || busyUserId === row.user_id}
                                                    onClick={() => onToggleManaged(row)}
                                                    className="px-2 py-1 text-xs border border-line bg-surface hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title={row.is_admin_managed ? 'Unmark as admin-managed account' : 'Mark as admin-managed curator account'}
                                                >
                                                    {row.is_admin_managed ? 'Unmanage' : 'Manage'}
                                                </button>
                                                {row.is_admin_managed && (
                                                    <button
                                                        type="button"
                                                        disabled={isDeleted || busyUserId === row.user_id}
                                                        onClick={() => onEditManagedLabel(row)}
                                                        className="px-2 py-1 text-xs border border-line bg-surface hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
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
                                                        className="px-2 py-1 text-xs border border-red-300 text-danger bg-surface hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        title="Merge this managed account into another user"
                                                    >
                                                        Merge
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    disabled={isDeleted || row.is_admin || busyUserId === row.user_id}
                                                    onClick={() => onDelete(row)}
                                                    className="px-2 py-1 text-xs border border-red-300 text-danger bg-surface hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                    title={row.is_admin ? "Can't delete the admin from here" : 'Delete this account'}
                                                >
                                                    Delete
                                                </button>
                                                {isBlocked ? (
                                                    <button
                                                        type="button"
                                                        disabled={busyUserId === row.user_id}
                                                        onClick={() => setUnblockTarget(row)}
                                                        className="px-2 py-1 text-xs border border-line bg-surface hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
                                                        title="Allow this account to sign in again"
                                                    >
                                                        Unblock
                                                    </button>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        disabled={isDeleted || row.is_admin || busyUserId === row.user_id}
                                                        onClick={() => setBlockPrompt(row)}
                                                        className="px-2 py-1 text-xs border border-red-300 text-danger bg-surface hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
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
                    footer={
                        <button type="button" onClick={() => setFiltersOpen(false)} className="min-h-11 w-full bg-action text-sm font-semibold text-white hover:opacity-90">
                            {loading ? 'Loading…' : `Show ${total.toLocaleString()} user${total === 1 ? '' : 's'}`}
                        </button>
                    }
                >
                    <div className="space-y-5 pb-2">
                        <section className="space-y-2">
                            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Sort</h3>
                            <div className="flex gap-2">
                                <select
                                    aria-label="Sort by"
                                    value={sortBy}
                                    onChange={(e) => setSortBy(e.target.value as AdminUserSortField)}
                                    className="min-h-11 min-w-0 flex-1 border border-line bg-surface px-3 text-base text-ink"
                                >
                                    <option value="created_at">Created</option>
                                    <option value="last_visit_at">Last visit</option>
                                    <option value="followers_count">Followers</option>
                                    <option value="following_count">Following</option>
                                    <option value="has_push_subscription">Push</option>
                                    <option value="installed_at">Installed app</option>
                                </select>
                                <button
                                    type="button"
                                    onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                                    className="min-h-11 shrink-0 border border-line bg-surface px-3 text-sm text-ink"
                                >
                                    {sortDir === 'asc' ? 'Ascending ▲' : 'Descending ▼'}
                                </button>
                            </div>
                        </section>
                        <div className="-mx-4 divide-y divide-line border-y border-line">
                            {([
                                ['Include deleted', includeDeleted, setIncludeDeleted],
                                ['Verified organizers only', verifiedOnly, setVerifiedOnly],
                            ] as const).map(([label, checked, set]) => (
                                <label key={label} className="flex min-h-12 items-center justify-between gap-3 px-4 text-sm text-ink">
                                    {label}
                                    <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} className="h-5 w-5" />
                                </label>
                            ))}
                        </div>
                    </div>
                </BottomSheet>
            )}
            {isMobile && actionRow && (
                <UserActionsSheet
                    row={actionRow}
                    busy={busyUserId === actionRow.user_id}
                    fmtDate={fmtDate}
                    onAction={runUserAction}
                    onClose={() => setActionRow(null)}
                />
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
            {organizerTarget && (
                <AdminOrganizerSheet
                    userId={organizerTarget.user_id}
                    label={userLabel(organizerTarget)}
                    verified={organizerTarget.is_verified_organizer}
                    onClose={() => setOrganizerTarget(null)}
                    onChanged={() => void load()}
                />
            )}
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

function UserActionsSheet({ row, busy, fmtDate, onAction, onClose }: {
    row: AdminUserRow;
    busy: boolean;
    fmtDate: (iso: string | null) => string;
    onAction: (key: UserActionKey, row: AdminUserRow) => void;
    onClose: () => void;
}) {
    const isDeleted = row.deleted_at !== null;
    const actions: { key: UserActionKey; label: string; disabled?: boolean; danger?: boolean }[] = [
        { key: 'organizer', label: row.is_verified_organizer ? 'Organizer ✓' : 'Organizer', disabled: isDeleted },
        { key: 'managed', label: row.is_admin_managed ? 'Unmanage' : 'Manage', disabled: isDeleted || row.is_admin },
        ...(row.is_admin_managed ? [{ key: 'label' as const, label: 'Edit label', disabled: isDeleted }] : []),
        { key: 'push', label: row.force_enable_push_prompt ? 'Unforce push prompt' : 'Force push prompt', disabled: isDeleted },
        { key: 'install', label: row.force_install_prompt ? 'Unforce install prompt' : 'Force install prompt', disabled: isDeleted },
        ...(!row.installed_at ? [{ key: 'install-email' as const, label: 'Send install email', disabled: isDeleted }] : []),
        { key: 'onboarding', label: 'Retrigger onboarding', disabled: isDeleted || row.needs_onboarding },
        ...(row.is_admin_managed ? [{ key: 'merge' as const, label: 'Merge into…', disabled: isDeleted || row.is_admin, danger: true }] : []),
        row.active_block_id !== null
            ? { key: 'unblock', label: 'Unblock' }
            : { key: 'block', label: 'Block…', disabled: isDeleted || row.is_admin, danger: true },
        { key: 'delete', label: 'Delete…', disabled: isDeleted || row.is_admin, danger: true },
    ];
    return (
        <BottomSheet title={row.display_name || (row.handle ? `@${row.handle}` : row.email)} subtitle={row.email} onClose={onClose}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 pb-3 text-sm">
                <dt className="text-ink-soft">Created</dt><dd className="text-ink">{fmtDate(row.created_at)}</dd>
                <dt className="text-ink-soft">Installed</dt><dd className="text-ink">{row.installed_at ? fmtDate(row.installed_at) : 'Not installed'}</dd>
                <dt className="text-ink-soft">Onboarding</dt><dd className="text-ink">{row.needs_onboarding ? (row.onboarded_at ? 'Pending (v↑)' : 'Never') : '✓ Done'}</dd>
                <dt className="text-ink-soft">Push</dt><dd><PushSubscriptionCell on={row.has_push_subscription} /></dd>
                <dt className="text-ink-soft">Interest-match</dt><dd><FeatureStatusCell label="Interest-match" email={row.email_interest_matches_enabled} push={row.push_interest_matches_enabled} /></dd>
                <dt className="text-ink-soft">Reminders</dt><dd><FeatureStatusCell label="Event reminders" email={row.email_event_reminders_enabled} push={row.push_event_reminders_enabled} /></dd>
                <dt className="text-ink-soft">Digest</dt><dd><FeatureStatusCell label="Activity digest" email={row.email_social_activity_enabled} push={row.push_social_activity_enabled} /></dd>
            </dl>
            <ul className="-mx-4 divide-y divide-line border-t border-line">
                {actions.map((a) => (
                    <li key={a.key}>
                        <button
                            type="button"
                            disabled={a.disabled || busy}
                            onClick={() => onAction(a.key, row)}
                            className={`flex min-h-12 w-full items-center px-4 text-left text-sm hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-40 ${a.danger ? 'text-danger' : 'text-ink'}`}
                        >
                            {a.label}
                        </button>
                    </li>
                ))}
            </ul>
        </BottomSheet>
    );
}

function UserStatusChips({ row }: { row: AdminUserRow }) {
    const chips: [string, string][] = [
        ...(row.is_admin ? [['admin', 'bg-amber-100 text-amber-800'] as [string, string]] : []),
        ...(row.is_verified_organizer ? [['verified', 'bg-emerald-100 text-emerald-800'] as [string, string]] : []),
        ...(row.is_admin_managed ? [[`managed${row.managed_label ? `: ${row.managed_label}` : ''}`, 'border border-blue-200 bg-blue-50 text-action'] as [string, string]] : []),
        ...(row.deleted_at !== null ? [['deleted', 'bg-slate-200 text-ink'] as [string, string]] : []),
        ...(row.active_block_id !== null ? [['blocked', 'border border-red-200 bg-red-50 text-danger'] as [string, string]] : []),
    ];
    if (chips.length === 0) return null;
    return (
        <span className="mt-1 flex flex-wrap gap-1">
            {chips.map(([label, cls]) => <span key={label} className={`px-1.5 py-px text-xs ${cls}`}>{label}</span>)}
        </span>
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
    useBackToClose(onCancel, open);

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
                className="w-full max-w-lg border border-line bg-surface shadow-xl"
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
                <div className="border-b border-card-line px-4 py-3">
                    <h2 id="admin-merge-title" className="text-sm font-semibold text-ink">Merge Managed User</h2>
                </div>
                <div className="space-y-4 px-4 py-3 text-sm text-ink">
                    <div className="border border-red-200 bg-red-50 px-3 py-2 text-red-800">
                        {userDisplay(source)} will be soft-deleted after its data is moved. The destination user keeps their email, Google sign-in, handle, name, and avatar.
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="merge-destination-search" className="block font-medium text-ink">Search destination user</label>
                        <input
                            id="merge-destination-search"
                            type="search"
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                setFieldError(null);
                            }}
                            className="w-full border border-line px-3 py-2 text-sm text-ink focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                            placeholder="Search email, handle, or name"
                            autoFocus
                        />
                        <div className="max-h-44 overflow-y-auto border border-line bg-surface">
                            {searching && (
                                <div className="px-3 py-2 text-xs text-ink-soft">Searching…</div>
                            )}
                            {!searching && candidates.length === 0 && (
                                <div className="px-3 py-2 text-xs text-ink-soft">No active non-admin users found.</div>
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
                                            ? 'block w-full border-b border-card-line bg-action px-3 py-2 text-left text-xs text-white last:border-b-0'
                                            : 'block w-full border-b border-card-line bg-surface px-3 py-2 text-left text-xs text-ink hover:bg-canvas last:border-b-0'}
                                    >
                                        <span className="block font-medium">{userDisplay(row)}</span>
                                        <span className={selected ? 'block text-blue-50' : 'block text-ink-soft'}>{row.email}</span>
                                    </button>
                                );
                            })}
                        </div>
                        {fieldError && <p className="text-xs text-danger">{fieldError}</p>}
                        {searchError && <p className="text-xs text-danger">{searchError}</p>}
                    </div>
                    <div className="grid gap-2 border border-line bg-canvas px-3 py-2 text-xs text-ink-soft sm:grid-cols-2">
                        <div>
                            <div className="font-medium text-ink">Source</div>
                            <div>{userDisplay(source)}</div>
                            <div>{source.email}</div>
                        </div>
                        <div>
                            <div className="font-medium text-ink">Destination</div>
                            <div>{userDisplay(destination)}</div>
                            <div>{destination?.email ?? 'Choose a user'}</div>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="merge-reason" className="block font-medium text-ink">Internal reason</label>
                        <textarea
                            id="merge-reason"
                            value={reason}
                            maxLength={500}
                            onChange={(e) => setReason(e.target.value)}
                            className="min-h-20 w-full border border-line px-3 py-2 text-sm text-ink focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                            placeholder="Blocked Google account recovery"
                        />
                    </div>
                </div>
                <div className="flex justify-end gap-2 border-t border-card-line px-4 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!destinationUserId}
                        className="bg-danger px-3 py-1.5 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Merge
                    </button>
                </div>
            </form>
        </div>
    );
}
