import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fetchTagGroups, type InterestProfile, type InterestProfilePayload } from '../api';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import { useInterestProfiles } from '../hooks/useInterestProfiles';
import type { TagGroup } from '../types';
import { REACH_FILTER_LABELS } from '../utils/reach';
import { bboxSearchArea, searchAreaFromProfile } from '../utils/searchArea';
import ProfileDraftEditor from './ProfileDraftEditor';
import { useToast } from './Toast';

type Confirmation =
    | { kind: 'default'; profile: InterestProfile }
    | { kind: 'delete'; profile: InterestProfile }
    | { kind: 'blocked'; profile: InterestProfile }
    | null;

function labelsFor(ids: number[], group: TagGroup | null): string[] {
    if (!group) return [];
    const labels = new Map(group.tags.map((tag) => [tag.id, tag.label]));
    return ids.map((id) => labels.get(id)).filter((label): label is string => Boolean(label));
}

function reachLabel(profile: InterestProfile, reachGroup: TagGroup | null): string {
    void reachGroup;
    return REACH_FILTER_LABELS[profile.reach_filter];
}

function ProfileIcon({ profile }: { profile: InterestProfile }) {
    const nearHome = profile.label.trim().toLowerCase() === 'near home';
    const icon = nearHome ? '⌂' : profile.geo_kind === 'radius' ? '⌖' : '⊞';
    return (
        <span
            aria-hidden="true"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-card text-xl ${nearHome ? 'bg-emerald-50 text-success' : 'bg-blue-50 text-action'}`}
        >
            {icon}
        </span>
    );
}

function ProfileCard({
    profile,
    danceGroup,
    reachGroup,
    onEdit,
    onMenu,
}: {
    profile: InterestProfile;
    danceGroup: TagGroup | null;
    reachGroup: TagGroup | null;
    onEdit: () => void;
    onMenu: () => void;
}) {
    const dances = labelsFor(profile.dance_tag_ids, danceGroup);
    return (
        <div className={`flex items-start rounded-card border bg-surface p-3 ${profile.is_active ? 'border-blue-200 bg-blue-50/30' : 'border-card-line'}`}>
            <button type="button" onClick={onEdit} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                <ProfileIcon profile={profile} />
                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{profile.label}</span>
                        {profile.is_active && <span className="shrink-0 rounded border border-blue-200 bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-action">Default</span>}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-ink-soft">{profile.area_label}</span>
                    <span className="mt-1 block truncate text-xs text-ink-soft">
                        {dances.length > 0 ? dances.join(', ') : 'Any dance style'} · {reachLabel(profile, reachGroup)}
                    </span>
                </span>
            </button>
            <button
                type="button"
                aria-label={`Manage ${profile.label}`}
                onClick={onMenu}
                className="-mr-1 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center text-lg font-bold text-ink hover:text-action"
            >
                •••
            </button>
        </div>
    );
}

function Sheet({ children, onClose, label, wide = false }: { children: ReactNode; onClose: () => void; label: string; wide?: boolean }) {
    return createPortal(
        <div className="fixed inset-0 z-[11000] flex items-end bg-slate-900/40 sm:items-center sm:justify-center sm:p-4" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-label={label} onClick={(event) => event.stopPropagation()} className={`max-h-[92dvh] w-full overflow-y-auto rounded-t-card bg-surface p-3 shadow-xl sm:rounded-card ${wide ? 'sm:max-w-lg' : 'sm:max-w-sm'}`}>
                {children}
            </div>
        </div>,
        document.body,
    );
}

export default function InterestProfilesManager() {
    const toast = useToast();
    const { profiles, error, setError, createProfile, updateProfile, deleteProfile, activateProfile } = useInterestProfiles();
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [menuProfile, setMenuProfile] = useState<InterestProfile | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation>(null);
    const [editorProfile, setEditorProfile] = useState<InterestProfile | 'new' | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void fetchTagGroups().then(setTagGroups).catch(() => setTagGroups([]));
    }, []);

    const danceGroup = useMemo(() => tagGroups.find((group) => group.slug === 'dance-style') ?? null, [tagGroups]);
    const reachGroup = useMemo(() => tagGroups.find((group) => group.slug === 'reach') ?? null, [tagGroups]);
    const defaultProfile = profiles?.find((profile) => profile.is_active) ?? null;
    const otherProfiles = profiles?.filter((profile) => !profile.is_active) ?? [];

    const duplicate = async (profile: InterestProfile) => {
        setBusy(true);
        setError(null);
        const payload: InterestProfilePayload = {
            label: `${profile.label} copy`,
            area_label: profile.area_label,
            geo_kind: profile.geo_kind,
            min_lat: profile.min_lat,
            min_lng: profile.min_lng,
            max_lat: profile.max_lat,
            max_lng: profile.max_lng,
            center_lat: profile.center_lat,
            center_lng: profile.center_lng,
            radius_km: profile.radius_km,
            dance_tag_ids: profile.dance_tag_ids,
            reach_filter: profile.reach_filter,
            matches_enabled: profile.matches_enabled,
            is_active: false,
        };
        try {
            await createProfile(payload);
            toast.push({ title: 'Profile duplicated', variant: 'success', duration: 2500 });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Failed to duplicate profile');
        } finally {
            setBusy(false);
        }
    };

    const confirmAction = async () => {
        if (!confirmation || confirmation.kind === 'blocked') {
            setConfirmation(null);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            if (confirmation.kind === 'default') {
                await activateProfile(confirmation.profile.id);
            } else {
                await deleteProfile(confirmation.profile.id);
                toast.push({ title: 'Profile deleted', variant: 'success', duration: 2500 });
            }
            setConfirmation(null);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Profile action failed');
        } finally {
            setBusy(false);
        }
    };

    const renderCard = (profile: InterestProfile) => (
        <ProfileCard
            key={profile.id}
            profile={profile}
            danceGroup={danceGroup}
            reachGroup={reachGroup}
            onEdit={() => setEditorProfile(profile)}
            onMenu={() => setMenuProfile(profile)}
        />
    );

    return (
        <div data-testid="interest-profiles-manager">
            <header className="mb-5">
                <h1 className="text-2xl font-bold text-ink">Search profiles</h1>
                <p className="mt-2 max-w-sm text-sm text-ink-soft">Use a profile to find events in Explore and get alerts that match your preferences.</p>
            </header>

            {profiles === null ? <p className="text-sm text-muted">Loading…</p> : (
                <div className="space-y-5">
                    {defaultProfile && <section><h2 className="mb-2 text-[11px] font-semibold uppercase text-ink-soft">Default profile</h2>{renderCard(defaultProfile)}</section>}
                    {otherProfiles.length > 0 && <section><h2 className="mb-2 text-[11px] font-semibold uppercase text-ink-soft">Other profiles</h2><div className="space-y-3">{otherProfiles.map(renderCard)}</div></section>}
                </div>
            )}

            <button type="button" onClick={() => setEditorProfile('new')} className="sticky bottom-4 mt-6 min-h-12 w-full border border-action bg-surface px-4 text-sm font-semibold text-action shadow-sm hover:bg-blue-50">
                + Create search profile
            </button>
            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}

            {editorProfile && <Sheet wide label={editorProfile === 'new' ? 'Create search profile' : `Edit ${editorProfile.label}`} onClose={() => setEditorProfile(null)}>
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-lg font-bold text-ink">{editorProfile === 'new' ? 'New profile' : editorProfile.label}</h2>
                    <button type="button" aria-label="Close profile editor" onClick={() => setEditorProfile(null)} className="h-10 w-10 text-xl text-ink-soft hover:text-ink">×</button>
                </div>
                <ProfileDraftEditor
                    key={editorProfile === 'new' ? 'new' : editorProfile.id}
                    mode={editorProfile === 'new' ? 'create' : 'edit'}
                    danceGroup={danceGroup}
                    initialValue={editorProfile === 'new' ? {
                        area: bboxSearchArea(DEFAULT_AREA_BBOX, 'preset'),
                        danceIds: [],
                        reachFilter: 'international',
                        matchesEnabled: true,
                    } : {
                        label: editorProfile.label,
                        area: searchAreaFromProfile(editorProfile),
                        danceIds: editorProfile.dance_tag_ids,
                        reachFilter: editorProfile.reach_filter,
                        matchesEnabled: editorProfile.matches_enabled,
                        nameEdited: true,
                    }}
                    onSave={async (payload) => {
                        if (editorProfile === 'new') await createProfile(payload);
                        else await updateProfile(editorProfile.id, payload);
                        setEditorProfile(null);
                    }}
                    onDelete={editorProfile === 'new' ? undefined : () => {
                        setConfirmation({ kind: editorProfile.is_active ? 'blocked' : 'delete', profile: editorProfile });
                        setEditorProfile(null);
                    }}
                />
            </Sheet>}

            {menuProfile && <Sheet label={`Manage ${menuProfile.label}`} onClose={() => setMenuProfile(null)}>
                <div className="divide-y divide-card-line">
                    {!menuProfile.is_active && <button type="button" onClick={() => { setConfirmation({ kind: 'default', profile: menuProfile }); setMenuProfile(null); }} className="flex min-h-12 w-full items-center gap-3 px-2 text-left text-sm font-semibold text-ink"><span aria-hidden="true">☆</span>Set as default</button>}
                    <button type="button" disabled={busy} onClick={() => { const profile = menuProfile; setMenuProfile(null); void duplicate(profile); }} className="flex min-h-12 w-full items-center gap-3 px-2 text-left text-sm font-semibold text-ink disabled:opacity-50"><span aria-hidden="true">▣</span>Duplicate</button>
                    <button type="button" onClick={() => { setConfirmation({ kind: menuProfile.is_active ? 'blocked' : 'delete', profile: menuProfile }); setMenuProfile(null); }} className="flex min-h-12 w-full items-center gap-3 px-2 text-left text-sm font-semibold text-danger"><span aria-hidden="true">⌫</span>Delete profile</button>
                </div>
            </Sheet>}

            {confirmation && <Sheet label={confirmation.kind === 'default' ? 'Set as default' : 'Delete profile'} onClose={() => !busy && setConfirmation(null)}>
                <div className="px-2 py-3 text-center">
                    <h2 className="text-lg font-bold text-ink">
                        {confirmation.kind === 'default' ? 'Set as default?' : confirmation.kind === 'delete' ? `Delete “${confirmation.profile.label}”?` : 'Default profile cannot be deleted'}
                    </h2>
                    <p className="mx-auto mt-2 max-w-xs text-sm text-ink-soft">
                        {confirmation.kind === 'default' ? 'This profile will be used automatically in Explore and for alerts.' : confirmation.kind === 'delete' ? 'This profile and its event alerts will be removed.' : 'To delete the default profile, set another profile as default first.'}
                    </p>
                </div>
                <div className="space-y-2 pt-2">
                    <button type="button" disabled={busy} onClick={() => void confirmAction()} className={`${confirmation.kind === 'delete' ? 'bg-danger' : 'bg-action'} min-h-12 w-full px-4 text-sm font-semibold text-white disabled:opacity-50`}>
                        {busy ? 'Saving…' : confirmation.kind === 'default' ? 'Set as default' : confirmation.kind === 'delete' ? 'Delete' : 'OK'}
                    </button>
                    {confirmation.kind !== 'blocked' && <button type="button" disabled={busy} onClick={() => setConfirmation(null)} className="min-h-11 w-full text-sm font-semibold text-action disabled:opacity-50">Cancel</button>}
                </div>
            </Sheet>}
        </div>
    );
}
