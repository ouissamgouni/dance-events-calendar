import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fetchTagGroups, type ReachFilter } from '../api';
import ProfileDraftEditor, { type ProfileDraftInitialValue } from '../components/ProfileDraftEditor';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import { useInterestProfiles } from '../hooks/useInterestProfiles';
import type { TagGroup } from '../types';
import {
    bboxSearchArea,
    searchAreaFromProfile,
    type SearchArea,
} from '../utils/searchArea';

interface EditorRouteState {
    returnTo?: string;
    initialSearch?: {
        area: SearchArea | null;
        areaLabel: string;
        danceIds: number[];
        reachFilter?: ReachFilter;
        reachIds: number[];
    };
}

export default function SearchProfileEditorPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const routeState = location.state as EditorRouteState | null;
    const returnTo = routeState?.returnTo ?? '/mine/profiles';
    const { profileId } = useParams();
    const editingId = profileId ? Number(profileId) : null;
    const { profiles, createProfile, updateProfile } = useInterestProfiles();
    const [groups, setGroups] = useState<TagGroup[]>([]);
    const [groupsLoaded, setGroupsLoaded] = useState(false);

    useEffect(() => {
        void fetchTagGroups()
            .then(setGroups)
            .catch(() => setGroups([]))
            .finally(() => setGroupsLoaded(true));
    }, []);

    const danceGroup = useMemo(() => groups.find((group) => group.slug === 'dance-style') ?? null, [groups]);
    const reachGroup = useMemo(() => groups.find((group) => group.slug === 'reach') ?? null, [groups]);
    const profile = editingId == null ? null : profiles?.find((item) => item.id === editingId) ?? null;

    if (!groupsLoaded || (editingId != null && profiles === null)) {
        return <p className="p-4 text-sm text-muted">Loading…</p>;
    }
    if (editingId != null && !profile) {
        return <p role="alert" className="p-4 text-sm text-danger">Profile not found.</p>;
    }

    let initialValue: ProfileDraftInitialValue;
    if (profile) {
        initialValue = {
            label: profile.label,
            area: searchAreaFromProfile(profile),
            danceIds: profile.dance_tag_ids,
            reachFilter: profile.reach_filter,
            matchesEnabled: profile.matches_enabled,
            nameEdited: true,
        };
    } else if (routeState?.initialSearch) {
        const initial = routeState.initialSearch;
        const regionalId = reachGroup?.tags.find((tag) => tag.slug === 'regional')?.id;
        initialValue = {
            area: initial.area
                ? { ...initial.area, label: initial.areaLabel }
                : bboxSearchArea(DEFAULT_AREA_BBOX, 'preset'),
            danceIds: initial.danceIds,
            reachFilter: initial.reachFilter
                ?? (regionalId != null && initial.reachIds.includes(regionalId)
                    ? 'regional_plus'
                    : initial.reachIds.length > 0 ? 'international' : 'any'),
            matchesEnabled: true,
        };
    } else {
        initialValue = {
            area: bboxSearchArea(DEFAULT_AREA_BBOX, 'preset'),
            danceIds: [],
            reachFilter: 'international',
            matchesEnabled: true,
        };
    }

    return (
        <div className="mx-auto flex min-h-full max-w-lg flex-col bg-surface">
            <header className="relative flex min-h-14 items-center justify-center border-b border-line px-14">
                <button type="button" onClick={() => navigate(returnTo)} className="absolute left-3 text-sm font-semibold text-action">Cancel</button>
                <h1 className="text-sm font-bold text-ink">{editingId == null ? 'Create profile' : 'Edit profile'}</h1>
            </header>
            <main className="flex-1 overflow-y-auto bg-canvas px-4 py-4">
                <ProfileDraftEditor
                    key={editingId ?? 'new'}
                    mode={editingId == null ? 'create' : 'edit'}
                    danceGroup={danceGroup}
                    initialValue={initialValue}
                    onSave={async (payload) => {
                        if (editingId == null) await createProfile(payload);
                        else await updateProfile(editingId, payload);
                        navigate(returnTo);
                    }}
                />
            </main>
        </div>
    );
}
