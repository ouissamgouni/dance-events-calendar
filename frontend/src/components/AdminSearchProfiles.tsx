import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    adminUpdateInterestProfile,
    fetchAdminInterestProfileClusters,
    fetchAdminInterestProfiles,
    fetchTagGroups,
    type AdminInterestProfileCluster,
    type AdminInterestProfileRow,
} from '../api';
import type { TagGroup } from '../types';
import { REACH_FILTER_LABELS } from '../utils/reach';
import { searchAreaFromProfile } from '../utils/searchArea';
import BottomSheet from './BottomSheet';
import ProfileDraftEditor from './ProfileDraftEditor';

const FLAG_LABELS: Record<string, string> = {
    no_dance_styles: 'Never matches (no dance style)',
    wide_area_any_reach: 'Wide area + any reach',
};

function useDanceGroup(): TagGroup | null {
    const [group, setGroup] = useState<TagGroup | null>(null);
    useEffect(() => {
        fetchTagGroups()
            .then((groups) => setGroup(groups.find((g) => g.slug === 'dance-style') ?? null))
            .catch(() => setGroup(null));
    }, []);
    return group;
}

function danceText(ids: number[], group: TagGroup | null): string {
    if (ids.length === 0) return 'No dance style';
    const labels = new Map((group?.tags ?? []).map((t) => [t.id, t.label]));
    return ids.map((id) => labels.get(id) ?? `#${id}`).join(', ');
}

function EditProfileSheet({ profile, danceGroup, onClose, onSaved }: {
    profile: AdminInterestProfileRow;
    danceGroup: TagGroup | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const owner = profile.user_display_name || (profile.user_handle ? `@${profile.user_handle}` : profile.user_email);
    return (
        <BottomSheet title="Edit search profile" subtitle={`${owner} · notified in-app`} titleSize="large" onClose={onClose} desktop="modal">
            <ProfileDraftEditor
                mode="edit"
                danceGroup={danceGroup}
                initialValue={{
                    label: profile.label,
                    area: searchAreaFromProfile(profile),
                    danceIds: profile.dance_tag_ids,
                    reachFilter: profile.reach_filter,
                    matchesEnabled: profile.matches_enabled,
                    nameEdited: true,
                }}
                onSave={async (payload) => {
                    await adminUpdateInterestProfile(profile.id, payload);
                    onSaved();
                }}
            />
        </BottomSheet>
    );
}

function ProfileRows({ rows, danceGroup, showOwner, onEdit }: {
    rows: AdminInterestProfileRow[];
    danceGroup: TagGroup | null;
    showOwner: boolean;
    onEdit: (row: AdminInterestProfileRow) => void;
}) {
    if (rows.length === 0) return <p className="text-sm text-ink-soft">No search profiles.</p>;
    return (
        <ul className="divide-y divide-line">
            {rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-ink">
                            {showOwner ? `${row.user_display_name || row.user_email} · ` : ''}{row.label}
                            {row.is_active && <span className="ml-1 text-xs text-ink-soft">(default)</span>}
                        </p>
                        <p className="truncate text-xs text-ink-soft">
                            {danceText(row.dance_tag_ids, danceGroup)} · {REACH_FILTER_LABELS[row.reach_filter]} · {row.area_label}
                        </p>
                        <p className="text-xs text-ink-soft">
                            {row.matches_enabled ? 'Alerts on' : 'Alerts off'} · {row.upcoming_match_count} upcoming matches · {row.notifications_30d} alerts in 30d
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => onEdit(row)}
                        className="shrink-0 border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-canvas"
                    >
                        Edit
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** Admin: one user's search profiles, editable with the user-facing editor. */
export function AdminUserSearchProfilesSheet({ userId, label, onClose }: {
    userId: string;
    label: string;
    onClose: () => void;
}) {
    const danceGroup = useDanceGroup();
    const [rows, setRows] = useState<AdminInterestProfileRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<AdminInterestProfileRow | null>(null);

    const load = useCallback(() => {
        fetchAdminInterestProfiles({ userId })
            .then(setRows)
            .catch((e: Error) => setError(e.message));
    }, [userId]);
    useEffect(load, [load]);

    return (
        <>
            <BottomSheet title="Search profiles" subtitle={label} titleSize="large" onClose={onClose} desktop="modal">
                {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                {rows === null && !error ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : (
                    <ProfileRows rows={rows ?? []} danceGroup={danceGroup} showOwner={false} onEdit={setEditing} />
                )}
            </BottomSheet>
            {editing && (
                <EditProfileSheet
                    profile={editing}
                    danceGroup={danceGroup}
                    onClose={() => setEditing(null)}
                    onSaved={() => { setEditing(null); load(); }}
                />
            )}
        </>
    );
}

/** Admin: similar search profiles grouped by dance styles, reach and area. */
export default function AdminSearchProfilesPanel() {
    const danceGroup = useDanceGroup();
    const [clusters, setClusters] = useState<AdminInterestProfileCluster[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [openKey, setOpenKey] = useState<string | null>(null);
    const [members, setMembers] = useState<AdminInterestProfileRow[] | null>(null);
    const [editing, setEditing] = useState<AdminInterestProfileRow | null>(null);

    const loadClusters = useCallback(() => {
        fetchAdminInterestProfileClusters()
            .then(setClusters)
            .catch((e: Error) => setError(e.message));
    }, []);
    useEffect(loadClusters, [loadClusters]);

    const loadMembers = useCallback((key: string) => {
        setMembers(null);
        fetchAdminInterestProfiles({ clusterKey: key })
            .then(setMembers)
            .catch((e: Error) => setError(e.message));
    }, []);

    const toggle = (key: string) => {
        if (openKey === key) {
            setOpenKey(null);
            return;
        }
        setOpenKey(key);
        loadMembers(key);
    };

    const totals = useMemo(() => ({
        profiles: clusters?.reduce((n, c) => n + c.profile_count, 0) ?? 0,
        clusters: clusters?.length ?? 0,
    }), [clusters]);

    return (
        <section className="space-y-3">
            <header className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-lg font-semibold">Search profiles</h2>
                <span className="text-xs text-ink-soft">{totals.profiles} profiles in {totals.clusters} groups</span>
            </header>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            {clusters === null && !error && <p className="text-sm text-muted">Loading…</p>}
            <ul className="divide-y divide-line border-y border-line bg-surface">
                {(clusters ?? []).map((c) => (
                    <li key={c.key}>
                        <button
                            type="button"
                            onClick={() => toggle(c.key)}
                            aria-expanded={openKey === c.key}
                            className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-left text-sm hover:bg-canvas"
                        >
                            <span className="min-w-0 flex-1 basis-64">
                                <span className="block truncate font-medium text-ink">{danceText(c.dance_tag_ids, danceGroup)}</span>
                                <span className="block truncate text-xs text-ink-soft">
                                    {REACH_FILTER_LABELS[c.reach_filter]} · {c.area_labels.join(' / ') || 'Area'} ({c.min_lat},{c.min_lng} → {c.max_lat},{c.max_lng})
                                </span>
                            </span>
                            <span className="text-xs text-ink-soft">{c.user_count} users · {c.matches_enabled_count} alerts on</span>
                            <span className="text-xs text-ink-soft">{c.upcoming_match_count} upcoming</span>
                            <span className="text-xs text-ink-soft">{c.notifications_30d_per_user} alerts/user 30d</span>
                            {c.flags.map((flag) => (
                                <span key={flag} className="border border-amber-200 bg-amber-50 px-1.5 py-px text-xs text-amber-800">
                                    {FLAG_LABELS[flag] ?? flag}
                                </span>
                            ))}
                        </button>
                        {openKey === c.key && (
                            <div className="bg-canvas px-3 pb-2">
                                {members === null ? (
                                    <p className="py-2 text-sm text-muted">Loading…</p>
                                ) : (
                                    <ProfileRows rows={members} danceGroup={danceGroup} showOwner onEdit={setEditing} />
                                )}
                            </div>
                        )}
                    </li>
                ))}
            </ul>
            {editing && (
                <EditProfileSheet
                    profile={editing}
                    danceGroup={danceGroup}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        loadClusters();
                        setOpenKey(null);
                    }}
                />
            )}
        </section>
    );
}
