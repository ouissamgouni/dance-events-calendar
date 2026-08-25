import { useEffect, useState } from 'react';
import type {
    InterestProfile,
    InterestProfilePayload,
    InterestProfileUpdatePayload,
} from '../api';
import type { TagGroup } from '../types';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import {
    summarizeSearchProfile,
    summarizeSelection,
    type CurrentSearchSelection,
} from '../utils/searchProfiles';
import ProfileDraftEditor, { type ProfileDraftInitialValue } from './ProfileDraftEditor';
import { ConfirmDialog } from './AppDialog';
import {
    bboxSearchArea,
    searchAreaFromProfile,
} from '../utils/searchArea';

type Step = 'picker' | 'save' | 'edit' | 'create';

export interface SearchProfileFlowProps {
    open: boolean;
    /** Which surface to open on: the profile picker or the Save sheet. */
    initialStep: 'picker' | 'save';
    onClose: () => void;
    variant?: 'sheet' | 'modal';

    profiles: InterestProfile[] | null;
    /** Currently-matched profile id, or ``'custom'`` when the live selection
     *  matches no saved profile. */
    selectedProfileId: number | 'custom';

    current: CurrentSearchSelection;
    currentAreaLabel: string;
    danceGroup: TagGroup | null;
    reachGroup: TagGroup | null;

    /** Apply a saved profile's Area + Dance + Reach to the live search. */
    onApplyProfile: (profile: InterestProfile) => void;
    /** Update the selected profile with the live Area/Dance/Reach. */
    onUpdateProfile: (profile: InterestProfile) => Promise<void>;
    createProfile: (payload: InterestProfilePayload) => Promise<InterestProfile>;
    updateProfile: (id: number, payload: InterestProfileUpdatePayload) => Promise<InterestProfile>;
    deleteProfile: (id: number) => Promise<void>;
}

const backIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 4 6 10l6 6" />
    </svg>
);

const pencilIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3l3 3-9 9H5v-3l9-9z" />
    </svg>
);

function Radio({ checked }: { checked: boolean }) {
    return (
        <span
            aria-hidden="true"
            className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? 'border-action' : 'border-line'}`}
        >
            {checked && <span className="h-2 w-2 rounded-full bg-action" />}
        </span>
    );
}

/** Centered-card shell (mobile and desktop), stacked above the FilterSheet.
 *  Constrained to fit within the available space without taking full screen. */
function FlowShell({
    title,
    onBack,
    children,
}: {
    title: string;
    onBack: () => void;
    children: React.ReactNode;
}) {
    const panel = (
        <div
            className="w-full max-w-md max-h-[min(85dvh,calc(100dvh-4rem))] bg-surface border border-line shadow-xl flex flex-col rounded-card overflow-hidden"
            data-testid="search-profile-flow"
        >
            <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-2">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1 text-sm font-semibold text-ink hover:text-action"
                    data-testid="search-profile-flow-back"
                >
                    {backIcon}
                    <span className="truncate">{title}</span>
                </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-canvas px-3 py-3">{children}</div>
        </div>
    );

    return (
        <div className="fixed inset-0 z-[8600] flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label={title}>
            <div className="w-full max-w-md">{panel}</div>
        </div>
    );
}

export default function SearchProfileFlow({
    open,
    initialStep,
    onClose,
    profiles,
    selectedProfileId,
    current,
    currentAreaLabel,
    danceGroup,
    reachGroup,
    onApplyProfile,
    onUpdateProfile,
    createProfile,
    updateProfile,
    deleteProfile,
}: SearchProfileFlowProps) {
    const [step, setStep] = useState<Step>(initialStep);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [draft, setDraft] = useState<ProfileDraftInitialValue | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [targetProfileId, setTargetProfileId] = useState<number | null>(null);

    // Reset to the requested entry step each time the flow opens.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            setStep(initialStep);
            setEditingId(null);
            setDraft(null);
            setError(null);
            // When opening the save step, preselect the active profile (default).
            if (initialStep === 'save') {
                const activeProfile = (profiles ?? []).find((p) => p.is_active);
                setTargetProfileId(activeProfile?.id ?? null);
            } else {
                setTargetProfileId(null);
            }
        });
        return () => { cancelled = true; };
    }, [open, initialStep, profiles]);

    if (!open) return null;

    const draftFromCurrent = (): ProfileDraftInitialValue => ({
        area: current.area
            ? { ...('kind' in current.area ? current.area : bboxSearchArea({ ...current.area, label: currentAreaLabel })), label: currentAreaLabel }
            : bboxSearchArea({ ...DEFAULT_AREA_BBOX, label: currentAreaLabel }, 'preset'),
        danceIds: [...current.danceIds],
        reachFilter: current.reachFilter,
        matchesEnabled: false,
    });

    const openCreate = (fromCurrent: boolean) => {
        setEditingId(null);
        setError(null);
        setDraft(fromCurrent ? draftFromCurrent() : {
            area: bboxSearchArea(DEFAULT_AREA_BBOX, 'preset'),
            danceIds: [],
            reachFilter: 'international',
            matchesEnabled: false,
        });
        setStep('create');
    };

    const openEdit = (profile: InterestProfile) => {
        setEditingId(profile.id);
        setError(null);
        setDraft({
            label: profile.label,
            area: searchAreaFromProfile(profile),
            danceIds: [...profile.dance_tag_ids],
            reachFilter: profile.reach_filter,
            matchesEnabled: profile.matches_enabled,
            nameEdited: true,
        });
        setStep('edit');
    };

    const handleSaveDraft = async (base: InterestProfilePayload) => {
        setError(null);
        try {
            if (editingId != null) {
                const updated = await updateProfile(editingId, base);
                if (selectedProfileId === editingId) onApplyProfile(updated);
            } else {
                const created = await createProfile(base);
                onApplyProfile(created);
            }
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save profile');
        }
    };

    const handleDelete = async () => {
        if (editingId == null) return;
        setConfirmDelete(false);
        setBusy(true);
        setError(null);
        try {
            await deleteProfile(editingId);
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to delete profile');
            setBusy(false);
        }
    };

    const handleUpdateProfile = async () => {
        const selectedProfile = (profiles ?? []).find((p) => p.id === targetProfileId);
        if (!selectedProfile) {
            setError('No profile selected.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onUpdateProfile(selectedProfile);
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update profile');
        } finally {
            setBusy(false);
        }
    };

    // ── Picker ───────────────────────────────────────────────────────────
    if (step === 'picker') {
        return (
            <FlowShell title="Choose search profile" onBack={onClose}>
                <ul className="flex flex-col gap-1" data-testid="search-profile-picker">
                    {selectedProfileId === 'custom' && (
                        <li className="flex items-start gap-3 px-2 py-3">
                            <Radio checked />
                            <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium text-ink">Current search</p>
                                <p className="mt-0.5 truncate text-xs text-ink-soft">
                                    {summarizeSelection(current, currentAreaLabel, danceGroup, reachGroup)}
                                </p>
                            </div>
                        </li>
                    )}
                    {(profiles ?? []).map((profile) => (
                        <li key={profile.id} className="flex items-start gap-3">
                            <button
                                type="button"
                                onClick={() => {
                                    onApplyProfile(profile);
                                    onClose();
                                }}
                                className="flex min-w-0 flex-1 items-start gap-3 px-2 py-3 text-left hover:bg-surface"
                                data-testid={`search-profile-apply-${profile.id}`}
                            >
                                <Radio checked={selectedProfileId === profile.id} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-medium text-ink">{profile.label}</p>
                                    <p className="mt-0.5 truncate text-xs text-ink-soft">
                                        {summarizeSearchProfile(profile, danceGroup, reachGroup)}
                                    </p>
                                </div>
                            </button>
                            <button
                                type="button"
                                onClick={() => openEdit(profile)}
                                aria-label={`Edit ${profile.label}`}
                                className="mt-2 inline-flex h-8 w-8 shrink-0 items-center justify-center text-ink-soft hover:text-action"
                                data-testid={`search-profile-edit-${profile.id}`}
                            >
                                {pencilIcon}
                            </button>
                        </li>
                    ))}
                </ul>
                <button
                    type="button"
                    onClick={() => openCreate(true)}
                    className="mt-2 inline-flex items-center gap-1.5 px-2 py-2 text-sm font-medium text-action hover:opacity-80"
                    data-testid="search-profile-create"
                >
                    <span aria-hidden="true">+</span> Create new profile
                </button>
                {error && <p className="mt-2 px-2 text-xs text-danger">{error}</p>}
            </FlowShell>
        );
    }

    // ── Save sheet ───────────────────────────────────────────────────────
    if (step === 'save') {
        const profileList = profiles ?? [];
        return (
            <FlowShell title="Save search profile" onBack={onClose}>
                <div className="flex flex-col gap-3" data-testid="search-profile-save">
                    {profileList.length > 0 && (
                        <>
                            <div>
                                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-ink-soft">
                                    Profile to update
                                </label>
                                <div className="flex flex-col gap-1 rounded-card border border-line bg-surface p-2">
                                    {profileList.map((profile) => (
                                        <button
                                            key={profile.id}
                                            type="button"
                                            onClick={() => setTargetProfileId(profile.id)}
                                            aria-pressed={targetProfileId === profile.id}
                                            className="flex items-center gap-3 px-2 py-2.5 text-left text-ink hover:bg-canvas transition-colors"
                                            data-testid={`search-profile-target-${profile.id}`}
                                        >
                                            <span className="h-4 w-4 shrink-0 rounded border-2 border-current flex items-center justify-center">
                                                {targetProfileId === profile.id && (
                                                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                                                )}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-xs font-medium">{profile.label}</p>
                                                {profile.is_active && (
                                                    <p className="text-xs opacity-75">Default</p>
                                                )}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleUpdateProfile}
                                disabled={busy || targetProfileId === null}
                                className="rounded-card border border-line bg-surface px-3 py-2.5 text-sm font-medium text-ink hover:bg-canvas disabled:opacity-50"
                                data-testid="search-profile-update"
                            >
                                {busy ? 'Updating…' : 'Update selected profile'}
                            </button>
                        </>
                    )}
                    <button
                        type="button"
                        onClick={() => openCreate(true)}
                        disabled={busy}
                        className="rounded-card border border-line bg-surface px-3 py-2.5 text-left hover:bg-canvas disabled:opacity-50"
                        data-testid="search-profile-save-new"
                    >
                        <p className="text-sm font-medium text-ink">Save as new profile</p>
                        <p className="mt-1 text-xs text-ink-soft">
                            Create a new search profile with the current settings.
                        </p>
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="mt-1 inline-flex w-full items-center justify-center border border-line bg-surface px-3 py-2.5 text-sm font-medium text-ink hover:bg-canvas"
                    >
                        Cancel
                    </button>
                    {error && <p className="px-1 text-xs text-danger">{error}</p>}
                </div>
            </FlowShell>
        );
    }

    // ── Edit / Create ────────────────────────────────────────────────────
    const isEdit = step === 'edit';
    const backTo = () => setStep(isEdit ? 'picker' : (initialStep === 'save' ? 'save' : 'picker'));
    return (
        <FlowShell title={isEdit ? 'Edit profile' : 'New profile'} onBack={backTo}>
            {draft && (
                <div data-testid="search-profile-editor">
                    <ProfileDraftEditor
                        key={`${step}-${editingId ?? 'new'}`}
                        mode={isEdit ? 'edit' : 'create'}
                        danceGroup={danceGroup}
                        initialValue={draft}
                        onSave={handleSaveDraft}
                        onDelete={isEdit ? () => setConfirmDelete(true) : undefined}
                    />
                    {error && <p className="mt-2 text-xs text-danger">{error}</p>}
                </div>
            )}
            <ConfirmDialog
                open={confirmDelete}
                title="Delete profile"
                message={`Delete "${draft?.label ?? ''}"? This can't be undone.`}
                confirmLabel="Delete"
                destructive
                onConfirm={handleDelete}
                onCancel={() => setConfirmDelete(false)}
            />
        </FlowShell>
    );
}
