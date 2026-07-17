import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    createInterestProfile,
    deleteInterestProfile,
    fetchInterestProfiles,
    fetchTagGroups,
    updateInterestProfile,
    type InterestProfile,
    type InterestProfileUpdatePayload,
    type PreferredAreaPayload,
} from '../api';
import type { TagGroup } from '../types';
import TagsPicker, { type TagsPickerValue } from './TagsPicker';
import AreaMapPicker from './AreaMapPicker';
import { ConfirmDialog } from './AppDialog';
import { DEFAULT_AREA_BBOX, isWideArea } from '../constants/area';
import { usePreferences } from '../context/PreferencesContext';

const GUARDRAIL_MESSAGE =
    'Large area: alerts and explorer results will include all local events. Narrow the Reach to focus.';

function tagLabels(ids: number[], group: TagGroup | null): string[] {
    if (!group) return [];
    const byId = new Map(group.tags.map((t) => [t.id, t.label]));
    return ids.map((id) => byId.get(id)).filter((l): l is string => !!l);
}

/** True when a profile's bbox is WIDE (diagonal > threshold). */
function profileIsWide(profile: Pick<InterestProfile, 'min_lat' | 'min_lng' | 'max_lat' | 'max_lng'>): boolean {
    return isWideArea({
        min_lat: profile.min_lat,
        min_lng: profile.min_lng,
        max_lat: profile.max_lat,
        max_lng: profile.max_lng,
    });
}

function summarizeGeo(profile: InterestProfile): string {
    return profileIsWide(profile) ? 'across a wide area' : 'in a local area';
}

interface ProfileCardProps {
    profile: InterestProfile;
    danceGroup: TagGroup | null;
    reachGroup: TagGroup | null;
    localTagId: number | null;
    defaultExpanded: boolean;
    /** True for the account's original/default profile (the one seeded at
     * signup) — its area-drag reset label reads "Default" instead of
     * "Custom" so the user still recognizes it. */
    isDefault: boolean;
    onSave: (id: number, payload: InterestProfileUpdatePayload) => Promise<void>;
    onDelete: (id: number) => Promise<void>;
    onToggleNotify: (id: number, value: boolean) => Promise<void>;
    onActivate: (id: number) => Promise<void>;
}

function ProfileCard({
    profile,
    danceGroup,
    reachGroup,
    localTagId,
    defaultExpanded,
    isDefault,
    onSave,
    onDelete,
    onToggleNotify,
    onActivate,
}: ProfileCardProps) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [labelDraft, setLabelDraft] = useState(profile.label);
    const [areaDraft, setAreaDraft] = useState({
        min_lat: profile.min_lat,
        min_lng: profile.min_lng,
        max_lat: profile.max_lat,
        max_lng: profile.max_lng,
    });
    const [danceValue, setDanceValue] = useState<TagsPickerValue>({
        selectedTagIds: [...profile.dance_tag_ids],
        freeTexts: {},
    });
    const [reachValue, setReachValue] = useState<TagsPickerValue>({
        selectedTagIds: [...profile.reach_tag_ids],
        freeTexts: {},
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
    const [savedFlash, setSavedFlash] = useState(false);
    const savedFlashTimerRef = useRef<number | null>(null);
    const labelDebounceRef = useRef<number | null>(null);
    const labelInputRef = useRef<HTMLInputElement | null>(null);
    const flashSaved = () => {
        setSavedFlash(true);
        if (savedFlashTimerRef.current != null) window.clearTimeout(savedFlashTimerRef.current);
        savedFlashTimerRef.current = window.setTimeout(() => setSavedFlash(false), 2000);
    };

    // Keep local drafts in sync when the profile is refreshed from the server
    // (e.g. after activation, delete-promotes-active, or a sibling profile
    // save). We only overwrite drafts when the persisted value actually
    // differs from what the user sees to avoid clobbering in-flight typing.
    useEffect(() => {
        setLabelDraft((prev) => (prev === profile.label ? prev : profile.label));
    }, [profile.label]);
    useEffect(() => {
        setAreaDraft((prev) =>
            prev.min_lat === profile.min_lat &&
                prev.min_lng === profile.min_lng &&
                prev.max_lat === profile.max_lat &&
                prev.max_lng === profile.max_lng
                ? prev
                : {
                    min_lat: profile.min_lat,
                    min_lng: profile.min_lng,
                    max_lat: profile.max_lat,
                    max_lng: profile.max_lng,
                },
        );
    }, [profile.min_lat, profile.min_lng, profile.max_lat, profile.max_lng]);

    const autoSaveLabel = useCallback(
        async (nextLabel: string) => {
            const trimmed = nextLabel.trim();
            // Skip empty (leave the input alone) and no-op renames.
            if (!trimmed || trimmed === profile.label) return;
            setSaving(true);
            setError(null);
            try {
                await onSave(profile.id, { label: trimmed });
                flashSaved();
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to save profile');
            } finally {
                setSaving(false);
            }
        },
        [onSave, profile.id, profile.label],
    );

    // Debounced label autosave: fires after the user stops typing.
    useEffect(() => {
        if (labelDebounceRef.current != null) window.clearTimeout(labelDebounceRef.current);
        labelDebounceRef.current = window.setTimeout(() => {
            void autoSaveLabel(labelDraft);
        }, 700);
        return () => {
            if (labelDebounceRef.current != null) window.clearTimeout(labelDebounceRef.current);
        };
    }, [labelDraft, autoSaveLabel]);

    const sameIdSet = (a: number[], b: number[]) =>
        a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

    const handleDanceChange = (next: TagsPickerValue) => {
        setDanceValue(next);
        if (sameIdSet(next.selectedTagIds, profile.dance_tag_ids)) return;
        setSaving(true);
        setError(null);
        onSave(profile.id, { dance_tag_ids: next.selectedTagIds })
            .then(() => flashSaved())
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to save profile'))
            .finally(() => setSaving(false));
    };

    const handleReachChange = (next: TagsPickerValue) => {
        setReachValue(next);
        if (sameIdSet(next.selectedTagIds, profile.reach_tag_ids)) return;
        setSaving(true);
        setError(null);
        onSave(profile.id, { reach_tag_ids: next.selectedTagIds })
            .then(() => flashSaved())
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to save profile'))
            .finally(() => setSaving(false));
    };

    const draftIsWide = isWideArea(areaDraft);
    const draftReachIncludesLocalOrEmpty =
        reachValue.selectedTagIds.length === 0 ||
        (localTagId != null && reachValue.selectedTagIds.includes(localTagId));
    const showGuardrailHint = draftIsWide && draftReachIncludesLocalOrEmpty;

    const handleDelete = async () => {
        setConfirmDeleteOpen(false);
        setSaving(true);
        setError(null);
        try {
            await onDelete(profile.id);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to delete profile');
            setSaving(false);
        }
    };

    const handleToggleActive = () => {
        // Active is single-select across all profiles — turning it "off" on
        // the currently-active row would leave the account with no active
        // profile. Ignore that direction; activation only ever promotes.
        if (profile.is_active) return;
        void onActivate(profile.id);
    };

    const openEditor = () => {
        setExpanded(true);
        window.setTimeout(() => {
            labelInputRef.current?.focus();
            labelInputRef.current?.select();
        }, 0);
    };

    const danceLabels = tagLabels(profile.dance_tag_ids, danceGroup);
    const reachLabels = tagLabels(profile.reach_tag_ids, reachGroup);

    return (
        <div
            className={`border p-3 ${profile.is_active ? 'border-blue-300 bg-blue-50/30' : 'border-slate-200'}`}
            data-testid="interest-profile-card"
        >
            {/* Header: expand + label on the left; Edit/Delete/Active/Notify on the right. */}
            <div className="flex items-start justify-between gap-3">
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    className="min-w-0 flex-1 text-left"
                >
                    <div className="flex items-center gap-2">
                        <span className="text-slate-400 text-xs" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                        <p className="truncate text-sm font-medium text-slate-900">{profile.label}</p>
                    </div>
                    {!expanded && (
                        <p className="mt-0.5 pl-5 text-xs text-slate-600">
                            {danceLabels.length ? danceLabels.join(', ') : 'Any dance style'}
                            {' · '}
                            {reachLabels.length ? reachLabels.join('/') : 'Any scale'}
                            {' · '}
                            {summarizeGeo(profile)}
                        </p>
                    )}
                </button>
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    <button
                        type="button"
                        onClick={openEditor}
                        className="text-blue-600 hover:text-blue-700"
                    >
                        Edit
                    </button>
                    <button
                        type="button"
                        onClick={() => setConfirmDeleteOpen(true)}
                        disabled={saving}
                        className="text-red-600 hover:text-red-700 disabled:text-slate-400"
                    >
                        Delete
                    </button>
                    <label
                        className="flex items-center gap-1.5 text-slate-500"
                        title={profile.is_active ? 'Currently active — activate another profile to swap' : 'Make this profile filter your Explorer and For You results'}
                    >
                        <input
                            type="checkbox"
                            checked={profile.is_active}
                            disabled={saving || profile.is_active}
                            onChange={handleToggleActive}
                            className="h-3.5 w-3.5"
                            aria-label="Active profile"
                        />
                        Active
                    </label>
                    <label
                        className="flex items-center gap-1.5 text-slate-500"
                        title="Show new events here. Getting them in email/push requires the matching Notifications toggle."
                    >
                        <input
                            type="checkbox"
                            checked={profile.matches_enabled}
                            disabled={saving}
                            onChange={(e) => onToggleNotify(profile.id, e.target.checked)}
                            className="h-3.5 w-3.5"
                        />
                        Match
                    </label>
                </div>
            </div>

            {expanded && (
                <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                    <div>
                        <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-1">
                            Label
                        </label>
                        <div className="flex items-center gap-2">
                            <input
                                ref={labelInputRef}
                                type="text"
                                value={labelDraft}
                                onChange={(e) => setLabelDraft(e.target.value)}
                                aria-label="Profile label"
                                className="flex-1 border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <span
                                className={`text-[11px] transition-opacity ${savedFlash ? 'text-emerald-600 opacity-100' : 'opacity-0'}`}
                                role="status"
                                aria-live="polite"
                            >
                                Saved
                            </span>
                        </div>
                    </div>

                    {danceGroup && (
                        <div>
                            <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-1">
                                Dance styles
                            </label>
                            <TagsPicker
                                tagGroups={[danceGroup]}
                                value={danceValue}
                                onChange={handleDanceChange}
                                allowFreeText={false}
                                searchable={false}
                            />
                        </div>
                    )}

                    {reachGroup && (
                        <div>
                            <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-1">
                                Reach (leave empty to match any scale)
                            </label>
                            <TagsPicker
                                tagGroups={[reachGroup]}
                                value={reachValue}
                                onChange={handleReachChange}
                                allowFreeText={false}
                                searchable={false}
                            />
                        </div>
                    )}

                    <div>
                        <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-1">
                            Area
                        </label>
                        <AreaMapPicker
                            value={{ ...areaDraft, label: labelDraft }}
                            onChange={(next) => {
                                setAreaDraft({
                                    min_lat: next.min_lat,
                                    min_lng: next.min_lng,
                                    max_lat: next.max_lat,
                                    max_lng: next.max_lng,
                                });
                                // A saved area is no longer the previously
                                // named place — reset the label (user can
                                // rename afterwards). The account's default
                                // profile resets to "Default"; additional
                                // profiles reset to "Custom".
                                const resetLabel = isDefault ? 'Default' : 'Custom';
                                setLabelDraft(resetLabel);
                                setSaving(true);
                                setError(null);
                                onSave(profile.id, {
                                    label: resetLabel,
                                    min_lat: next.min_lat,
                                    min_lng: next.min_lng,
                                    max_lat: next.max_lat,
                                    max_lng: next.max_lng,
                                })
                                    .then(() => flashSaved())
                                    .catch((e) => setError(e instanceof Error ? e.message : 'Failed to save profile'))
                                    .finally(() => setSaving(false));
                            }}
                            onUseCurrentView={() => {
                                window.setTimeout(() => {
                                    labelInputRef.current?.focus();
                                    labelInputRef.current?.select();
                                }, 0);
                            }}
                        />
                    </div>

                    {showGuardrailHint && (
                        <p className="border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                            {GUARDRAIL_MESSAGE}
                        </p>
                    )}
                </div>
            )}

            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

            <ConfirmDialog
                open={confirmDeleteOpen}
                title="Delete profile"
                message={`Delete "${profile.label}"? You'll stop getting notifications from this profile.`}
                confirmLabel="Delete"
                destructive
                onConfirm={handleDelete}
                onCancel={() => setConfirmDeleteOpen(false)}
            />
        </div>
    );
}

/**
 * Profiles manager (interest-profiles PRD §9): lists the signed-in user's
 * interest profiles, lets them edit dance/reach tags + geography + label,
 * toggle per-profile notifications, activate one profile, add new
 * profiles, and delete them. Rendered inside {@link PreferencesSection}.
 */
export default function InterestProfilesManager() {
    const { setPrefs } = usePreferences();
    const [profiles, setProfiles] = useState<InterestProfile[] | null>(null);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    // On mobile, the active profile card starts collapsed to keep the
    // Settings page compact; desktop keeps the prior expanded-by-default
    // behavior.
    const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : false));
    useEffect(() => {
        const mq = window.matchMedia('(max-width: 639px)');
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    // Mirror an active profile's area + tags into PreferencesContext so
    // the Explorer / For You default filters match the user's active
    // profile. Both dance-style and reach ids are mirrored — the Explorer
    // treats ``prefs.tagIds`` as an OR-filter across every tag group, so
    // omitting reach here means the reach constraint is lost as soon as
    // the user leaves the Profiles panel.
    const mirrorActiveToPrefs = useCallback(
        async (profile: InterestProfile) => {
            if (!profile.is_active) return;
            const next: { area?: PreferredAreaPayload | null; tagIds?: number[] } = {
                tagIds: [...profile.dance_tag_ids, ...profile.reach_tag_ids],
                area: {
                    min_lat: profile.min_lat,
                    min_lng: profile.min_lng,
                    max_lat: profile.max_lat,
                    max_lng: profile.max_lng,
                    label: profile.label,
                },
            };
            try {
                await setPrefs(next);
            } catch {
                /* soft-fail: mirroring is best-effort */
            }
        },
        [setPrefs],
    );

    useEffect(() => {
        Promise.all([fetchInterestProfiles(), fetchTagGroups()])
            .then(([p, groups]) => {
                setProfiles(p);
                setTagGroups(groups);
            })
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load profiles'));
    }, []);

    const danceGroup = useMemo(() => tagGroups.find((g) => g.slug === 'dance-style') ?? null, [tagGroups]);
    const reachGroup = useMemo(() => tagGroups.find((g) => g.slug === 'reach') ?? null, [tagGroups]);
    const localTagId = useMemo(
        () => reachGroup?.tags.find((t) => t.slug === 'local')?.id ?? null,
        [reachGroup],
    );

    const handleAdd = async () => {
        setAdding(true);
        setError(null);
        try {
            await createInterestProfile({
                label: 'New profile',
                min_lat: DEFAULT_AREA_BBOX.min_lat,
                min_lng: DEFAULT_AREA_BBOX.min_lng,
                max_lat: DEFAULT_AREA_BBOX.max_lat,
                max_lng: DEFAULT_AREA_BBOX.max_lng,
                dance_tag_ids: [],
                reach_tag_ids: [],
                matches_enabled: true,
            });
            const next = await fetchInterestProfiles();
            setProfiles(next);
            const active = next.find((p) => p.is_active);
            if (active) await mirrorActiveToPrefs(active);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to add profile');
        } finally {
            setAdding(false);
        }
    };

    const handleSaveProfile = async (id: number, payload: InterestProfileUpdatePayload) => {
        const updated = await updateInterestProfile(id, payload);
        setProfiles((prev) => (prev ? prev.map((p) => (p.id === id ? updated : p)) : prev));
        await mirrorActiveToPrefs(updated);
    };

    const handleDeleteProfile = async (id: number) => {
        await deleteInterestProfile(id);
        // A delete may have promoted another profile to active on the server;
        // re-fetch to keep the local list authoritative.
        const next = await fetchInterestProfiles();
        setProfiles(next);
        const active = next.find((p) => p.is_active);
        if (active) await mirrorActiveToPrefs(active);
    };

    const handleToggleNotify = async (id: number, value: boolean) => {
        setError(null);
        try {
            const updated = await updateInterestProfile(id, { matches_enabled: value });
            setProfiles((prev) => (prev ? prev.map((p) => (p.id === id ? updated : p)) : prev));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update profile');
        }
    };

    const handleActivate = async (id: number) => {
        setError(null);
        try {
            await updateInterestProfile(id, { is_active: true });
            // Activating unsets is_active on every other profile server-side;
            // re-fetch to mirror the new state atomically.
            const next = await fetchInterestProfiles();
            setProfiles(next);
            const active = next.find((p) => p.id === id);
            if (active) await mirrorActiveToPrefs(active);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to activate profile');
        }
    };

    return (
        <div className="mt-4 pt-4 border-t border-slate-200" data-testid="interest-profiles-manager">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Profiles
            </div>
            <p className="text-xs text-slate-600 mb-2">
                Your active profile filters the Explorer and For You results. Matching events always appear in-app; getting them by email or push requires{' '}
                <strong>Email → Interest matches</strong> (or the push equivalent) in Notifications.
            </p>

            {profiles === null ? (
                <p className="text-xs text-slate-400">Loading…</p>
            ) : profiles.length === 0 ? (
                <p className="text-xs text-slate-600 mb-2">
                    You don't have any profiles yet. Add one to filter results and get notified about matching events.
                </p>
            ) : (
                <div className="space-y-2 mb-2">
                    {profiles.map((profile) => (
                        <ProfileCard
                            key={profile.id}
                            profile={profile}
                            danceGroup={danceGroup}
                            reachGroup={reachGroup}
                            localTagId={localTagId}
                            defaultExpanded={profile.is_active && !isMobile}
                            isDefault={profile.id === profiles[0].id}
                            onSave={handleSaveProfile}
                            onDelete={handleDeleteProfile}
                            onToggleNotify={handleToggleNotify}
                            onActivate={handleActivate}
                        />
                    ))}
                </div>
            )}

            <button
                type="button"
                onClick={handleAdd}
                disabled={adding}
                className="bg-blue-500 text-white px-3 py-1.5 text-xs font-medium hover:bg-blue-600 disabled:bg-slate-300"
            >
                {adding ? 'Adding…' : '+ Add profile'}
            </button>

            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
    );
}
