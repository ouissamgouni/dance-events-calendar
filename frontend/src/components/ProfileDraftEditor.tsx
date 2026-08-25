import { useEffect, useState } from 'react';
import type { InterestProfilePayload, ReachFilter } from '../api';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import type { TagGroup } from '../types';
import { generateProfileName } from '../utils/searchProfiles';
import { REACH_FILTER_ICON_SRC, REACH_FILTER_LABELS } from '../utils/reach';
import {
    bboxSearchArea,
    toProfileGeometry,
    type SearchArea,
} from '../utils/searchArea';
import AreaEditor from './AreaEditor';
import AreaMapPreview from './AreaMapPreview';

export interface ProfileDraftInitialValue {
    label?: string;
    area?: SearchArea | null;
    danceIds: number[];
    reachFilter: ReachFilter;
    matchesEnabled: boolean;
    nameEdited?: boolean;
}

interface Props {
    initialValue: ProfileDraftInitialValue;
    danceGroup: TagGroup | null;
    mode: 'create' | 'edit';
    onSave: (payload: InterestProfilePayload) => Promise<void>;
    onDelete?: () => void;
}

type View = 'summary' | 'dance' | 'area' | 'reach';

function danceLabels(ids: number[], group: TagGroup | null): string[] {
    if (!group) return [];
    const labels = new Map(group.tags.map((tag) => [tag.id, tag.label]));
    return ids.map((id) => labels.get(id)).filter((label): label is string => Boolean(label));
}

function SummaryRow({
    icon,
    title,
    value,
    preview,
    onClick,
}: {
    icon: string;
    title: string;
    value: string;
    preview?: React.ReactNode;
    onClick: () => void;
}) {
    return (
        <button type="button" onClick={onClick} className="flex min-h-20 w-full items-center gap-3 rounded-card border border-card-line bg-surface p-4 text-left hover:bg-canvas">
            <span className="text-xl text-action" aria-hidden="true">{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">{title}</span>
                <span className="mt-1 block truncate text-sm text-ink-soft">{value}</span>
            </span>
            {preview}
            <span aria-hidden="true" className="text-xl text-ink-soft">›</span>
        </button>
    );
}

export default function ProfileDraftEditor({ initialValue, danceGroup, mode, onSave, onDelete }: Props) {
    const initialArea = initialValue.area ?? bboxSearchArea(DEFAULT_AREA_BBOX, 'preset');
    const [view, setView] = useState<View>('summary');
    const [area, setArea] = useState<SearchArea>(initialArea);
    const [danceIds, setDanceIds] = useState(initialValue.danceIds);
    const [reachFilter, setReachFilter] = useState(initialValue.reachFilter);
    const [matchesEnabled, setMatchesEnabled] = useState(initialValue.matchesEnabled);
    const [nameEdited, setNameEdited] = useState(initialValue.nameEdited ?? Boolean(initialValue.label));
    const generatedName = generateProfileName({ danceIds, danceGroup, areaLabel: area.label, reachFilter });
    const [name, setName] = useState(initialValue.label ?? generatedName);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!nameEdited) setName(generatedName);
    }, [generatedName, nameEdited]);

    const save = async () => {
        if (!name.trim()) {
            setError('Enter a profile name.');
            return;
        }
        if (danceIds.length === 0) {
            setError('Choose at least one dance style.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await onSave({
                label: name.trim(),
                ...toProfileGeometry(area),
                dance_tag_ids: danceIds,
                reach_filter: reachFilter,
                matches_enabled: matchesEnabled,
            });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Failed to save profile');
        } finally {
            setSaving(false);
        }
    };

    if (view === 'dance') {
        return (
            <div data-testid="profile-draft-dance">
                <div className="mb-4 flex items-center gap-2">
                    <button type="button" onClick={() => setView('summary')} className="text-action hover:opacity-75" aria-label="Back">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <h2 className="text-lg font-bold text-ink">Dance styles</h2>
                </div>
                {!danceGroup ? <p className="text-sm text-muted">Loading dance styles…</p> : (
                    <div className="grid grid-cols-2 gap-2">
                        {danceGroup.tags.map((tag) => {
                            const selected = danceIds.includes(tag.id);
                            return (
                                <button
                                    key={tag.id}
                                    type="button"
                                    aria-pressed={selected}
                                    onClick={() => setDanceIds(selected ? danceIds.filter((id) => id !== tag.id) : [...danceIds, tag.id])}
                                    className={selected ? 'min-h-11 border border-action bg-action px-2 text-sm font-semibold text-white' : 'min-h-11 border border-line bg-surface px-2 text-sm font-semibold text-ink hover:bg-canvas'}
                                >
                                    {tag.label}{selected ? ' ✓' : ''}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    if (view === 'area') {
        return (
            <div data-testid="profile-draft-area">
                <div className="mb-4 flex items-center gap-2">
                    <button type="button" onClick={() => setView('summary')} className="text-action hover:opacity-75" aria-label="Back">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <h2 className="text-lg font-bold text-ink">Search area</h2>
                </div>
                <AreaEditor
                    value={area}
                    myArea={area}
                    onUseArea={setArea}
                    showSavedAreas={false}
                />
            </div>
        );
    }

    if (view === 'reach') {
        const reachDescriptions: Record<ReachFilter, string> = {
            any: 'All events, including events without a reach classification.',
            regional_plus: 'Regional and international events.',
            international: 'International events only.',
        };
        return (
            <div data-testid="profile-draft-reach">
                <div className="mb-4 flex items-center gap-2">
                    <button type="button" onClick={() => setView('summary')} className="text-action hover:opacity-75" aria-label="Back">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <h2 className="text-lg font-bold text-ink">Event reach</h2>
                </div>
                <div role="group" aria-label="Event reach" className="grid grid-cols-3 border border-line">
                    {(['any', 'regional_plus', 'international'] as const).map((choice) => (
                        <button
                            key={choice}
                            type="button"
                            aria-pressed={reachFilter === choice}
                            onClick={() => setReachFilter(choice)}
                            className={reachFilter === choice
                                ? 'flex min-h-14 flex-col items-center justify-center gap-1 bg-action px-2 text-xs font-semibold text-white'
                                : 'flex min-h-14 flex-col items-center justify-center gap-1 px-2 text-xs font-semibold text-ink'}
                        >
                            <img src={REACH_FILTER_ICON_SRC[choice]} alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
                            {REACH_FILTER_LABELS[choice]}
                        </button>
                    ))}
                </div>
                {reachFilter && (
                    <p className="mt-4 text-xs text-ink-soft">{reachDescriptions[reachFilter]}</p>
                )}
            </div>
        );
    }

    const dances = danceLabels(danceIds, danceGroup);
    return (
        <div className="space-y-4" data-testid="profile-draft-summary">
            <div>
                <label htmlFor="profile-draft-name" className="mb-1 block text-[11px] font-semibold uppercase text-ink-soft">Profile name</label>
                <input
                    id="profile-draft-name"
                    value={name}
                    onChange={(event) => {
                        setNameEdited(true);
                        setName(event.target.value);
                    }}
                    maxLength={120}
                    className="min-h-11 w-full cursor-pointer border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-ink hover:bg-canvas focus:border-action focus:outline-none"
                />
            </div>

            <div className="space-y-3">
                <SummaryRow icon="♪" title="Dance styles" value={dances.length > 0 ? dances.join(', ') : 'Choose dance styles'} onClick={() => setView('dance')} />
                <SummaryRow icon="◎" title="Area" value={area.label} preview={<AreaMapPreview area={area} className="h-12 w-16" />} onClick={() => setView('area')} />
                <SummaryRow icon="↗" title="Reach" value={REACH_FILTER_LABELS[reachFilter]} onClick={() => setView('reach')} />
            </div>

            <label className="flex min-h-12 items-center justify-between border-t border-line py-3 text-sm font-semibold text-ink">
                <span>New event alerts</span>
                <input type="checkbox" checked={matchesEnabled} onChange={(event) => setMatchesEnabled(event.target.checked)} className="h-5 w-5 accent-action" />
            </label>

            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex items-center gap-2">
                <button type="button" disabled={saving} onClick={() => void save()} className="min-h-12 flex-1 bg-action px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" data-testid="profile-draft-save">
                    {saving ? 'Saving…' : mode === 'create' ? 'Create profile' : 'Save changes'}
                </button>
                {mode === 'edit' && onDelete && (
                    <button type="button" disabled={saving} onClick={onDelete} className="min-h-12 border border-line bg-surface px-4 text-sm font-semibold text-danger disabled:opacity-50" data-testid="profile-draft-delete">Delete</button>
                )}
            </div>
        </div>
    );
}
