import { useEffect, useState } from 'react';
import type {
    InterestProfile,
    InterestProfilePayload,
    InterestProfileUpdatePayload,
    PreferredAreaPayload,
} from '../api';
import type { TagGroup } from '../types';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import {
    summarizeSearchProfile,
    summarizeSelection,
    type CurrentSearchSelection,
} from '../utils/searchProfiles';
import ProfileEditor from './ProfileEditor';
import type { TagsPickerValue } from './TagsPicker';
import { ConfirmDialog } from './AppDialog';

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
    localTagId: number | null;

    /** Apply a saved profile's Area + Dance + Reach to the live search. */
    onApplyProfile: (profile: InterestProfile) => void;
    /** Overwrite the default (active) profile with the live Area/Dance/Reach. */
    onUpdateDefault: () => Promise<void>;
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

interface EditDraft {
    label: string;
    area: PreferredAreaPayload;
    dance: TagsPickerValue;
    reach: TagsPickerValue;
    matchesEnabled: boolean;
}

export default function SearchProfileFlow({
    open,
    initialStep,
    onClose,
    variant: _unused,
    profiles,
    selectedProfileId,
    current,
    currentAreaLabel,
    danceGroup,
    reachGroup,
    localTagId,
    onApplyProfile,
    onUpdateDefault,
    createProfile,
    updateProfile,
    deleteProfile,
}: SearchProfileFlowProps) {
    const [step, setStep] = useState<Step>(initialStep);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [draft, setDraft] = useState<EditDraft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // Reset to the requested entry step each time the flow opens.
    useEffect(() => {
        if (open) {
            setStep(initialStep);
            setEditingId(null);
            setDraft(null);
            setError(null);
        }
    }, [open, initialStep]);

    if (!open) return null;

    const draftFromCurrent = (label: string): EditDraft => ({
        label,
        area: { ...(current.area ?? DEFAULT_AREA_BBOX), label },
        dance: { selectedTagIds: [...current.danceIds], freeTexts: {} },
        reach: { selectedTagIds: [...current.reachIds], freeTexts: {} },
        matchesEnabled: false,
    });

    const openCreate = (fromCurrent: boolean) => {
        setEditingId(null);
        setError(null);
        setDraft(fromCurrent ? draftFromCurrent('New profile') : {
            label: 'New profile',
            area: { ...DEFAULT_AREA_BBOX },
            dance: { selectedTagIds: [], freeTexts: {} },
            reach: { selectedTagIds: [], freeTexts: {} },
            matchesEnabled: false,
        });
        setStep('create');
    };

    const openEdit = (profile: InterestProfile) => {
        setEditingId(profile.id);
        setError(null);
        setDraft({
            label: profile.label,
            area: {
                min_lat: profile.min_lat,
                min_lng: profile.min_lng,
                max_lat: profile.max_lat,
                max_lng: profile.max_lng,
                label: profile.label,
            },
            dance: { selectedTagIds: [...profile.dance_tag_ids], freeTexts: {} },
            reach: { selectedTagIds: [...profile.reach_tag_ids], freeTexts: {} },
            matchesEnabled: profile.matches_enabled,
        });
        setStep('edit');
    };

    const handleSaveDraft = async () => {
        if (!draft) return;
        const name = draft.label.trim() || 'New profile';
        setBusy(true);
        setError(null);
        try {
            const base = {
                label: name,
                min_lat: draft.area.min_lat,
                min_lng: draft.area.min_lng,
                max_lat: draft.area.max_lat,
                max_lng: draft.area.max_lng,
                dance_tag_ids: draft.dance.selectedTagIds,
                reach_tag_ids: draft.reach.selectedTagIds,
                matches_enabled: draft.matchesEnabled,
            };
            if (editingId != null) await updateProfile(editingId, base);
            else await createProfile(base);
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save profile');
        } finally {
            setBusy(false);
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

    const handleUpdateDefault = async () => {
        setBusy(true);
        setError(null);
        try {
            await onUpdateDefault();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update default profile');
        } finally {
            setBusy(false);
        }
    };

    // ── Picker ───────────────────────────────────────────────────────────
    if (step === 'picker') {
        return (
            <FlowShell title="Choose search profile" onBack={onClose}>
                <ul className="flex flex-col gap-1" data-testid="search-profile-picker">
                    <li className="flex items-start gap-3 px-2 py-3">
                        <Radio checked={selectedProfileId === 'custom'} />
                        <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-ink">Custom</p>
                            <p className="mt-0.5 truncate text-xs text-ink-soft">
                                {summarizeSelection(current, currentAreaLabel, danceGroup, reachGroup)}
                            </p>
                        </div>
                    </li>
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
        return (
            <FlowShell title="Save search profile" onBack={onClose}>
                <div className="flex flex-col gap-3" data-testid="search-profile-save">
                    <button
                        type="button"
                        onClick={handleUpdateDefault}
                        disabled={busy}
                        className="rounded-card border border-line bg-surface p-4 text-left hover:bg-canvas disabled:opacity-50"
                        data-testid="search-profile-update-default"
                    >
                        <p className="text-sm font-semibold text-ink">Update default profile</p>
                        <p className="mt-1 text-xs text-ink-soft">
                            Replace the default profile's Area, Dance styles, and Reach with the current settings.
                        </p>
                    </button>
                    <button
                        type="button"
                        onClick={() => openCreate(true)}
                        disabled={busy}
                        className="rounded-card border border-line bg-surface p-4 text-left hover:bg-canvas disabled:opacity-50"
                        data-testid="search-profile-save-new"
                    >
                        <p className="text-sm font-semibold text-ink">Save as new profile</p>
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
                <div className="flex flex-col gap-3" data-testid="search-profile-editor">
                    <div>
                        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-soft">
                            Profile name
                        </label>
                        <input
                            type="text"
                            value={draft.label}
                            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                            aria-label="Profile name"
                            className="w-full border border-line px-2 py-2 text-sm focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                        />
                    </div>
                    <ProfileEditor
                        danceGroup={danceGroup}
                        reachGroup={reachGroup}
                        localTagId={localTagId}
                        danceValue={draft.dance}
                        reachValue={draft.reach}
                        onDanceChange={(v) => setDraft({ ...draft, dance: v })}
                        onReachChange={(v) => setDraft({ ...draft, reach: v })}
                        area={{ ...draft.area, label: draft.label }}
                        onAreaChange={(next) =>
                            setDraft({
                                ...draft,
                                area: {
                                    min_lat: next.min_lat,
                                    min_lng: next.min_lng,
                                    max_lat: next.max_lat,
                                    max_lng: next.max_lng,
                                    label: draft.label,
                                },
                            })
                        }
                        matchesEnabled={draft.matchesEnabled}
                        onMatchesEnabledChange={(v) => setDraft({ ...draft, matchesEnabled: v })}
                        matchesHint="Get an email when a new event matches this profile. You can change this anytime."
                    />
                    {error && <p className="text-xs text-danger">{error}</p>}
                    <div className="flex items-center gap-2 pb-2">
                        <button
                            type="button"
                            onClick={handleSaveDraft}
                            disabled={busy}
                            className="inline-flex flex-1 items-center justify-center bg-action px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                            data-testid="search-profile-save-draft"
                        >
                            {busy ? 'Saving…' : 'Save'}
                        </button>
                        {isEdit && (
                            <button
                                type="button"
                                onClick={() => setConfirmDelete(true)}
                                disabled={busy}
                                className="inline-flex items-center justify-center border border-line px-3 py-2.5 text-sm font-medium text-danger hover:bg-canvas disabled:opacity-50"
                                data-testid="search-profile-delete"
                            >
                                Delete profile
                            </button>
                        )}
                    </div>
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
