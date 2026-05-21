import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchTagGroups, type PreferredAreaPayload } from '../api';
import AreaMapPicker from '../components/AreaMapPicker';
import TagsPicker, { type TagsPickerValue } from '../components/TagsPicker';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import { usePreferences } from '../context/PreferencesContext';
import type { TagGroup } from '../types';

export default function OnboardingPreferences() {
    const navigate = useNavigate();
    const [sp] = useSearchParams();
    const next = sp.get('next') || '/';
    const followPath = `/onboarding/follow?next=${encodeURIComponent(next)}`;
    const { prefs, setPrefs } = usePreferences();
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [tagsValue, setTagsValue] = useState<TagsPickerValue>({
        selectedTagIds: [],
        freeTexts: {},
    });
    const [areaExpanded, setAreaExpanded] = useState(false);
    const [areaLabelDraft, setAreaLabelDraft] = useState(prefs.area?.label ?? DEFAULT_AREA_BBOX.label);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const areaNameInputRef = useRef<HTMLInputElement | null>(null);
    const initialTagIdsRef = useRef(prefs.tagIds);

    useEffect(() => {
        let cancelled = false;
        fetchTagGroups({ scope: 'event', onboarding: true })
            .then((groups) => {
                if (cancelled) return;
                setTagGroups(groups);
                const loadedEligibleTagIds = new Set(groups.flatMap((group) => group.tags.map((tag) => tag.id)));
                setTagsValue({
                    selectedTagIds: initialTagIdsRef.current.filter((id) => loadedEligibleTagIds.has(id)),
                    freeTexts: {},
                });
            })
            .catch(() => {
                if (!cancelled) setTagGroups([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const eligibleTagIds = useMemo(() => {
        return new Set(tagGroups.flatMap((group) => group.tags.map((tag) => tag.id)));
    }, [tagGroups]);

    const visibleGroups = useMemo(
        () => tagGroups.filter((g) => g.enabled !== false && g.tags.some((t) => t.enabled !== false)),
        [tagGroups],
    );

    const handleAreaChange = async (nextArea: PreferredAreaPayload | null) => {
        setSaving(true);
        setError(null);
        setAreaLabelDraft(nextArea?.label ?? DEFAULT_AREA_BBOX.label);
        try {
            await setPrefs({ area: nextArea });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save map preferences');
        } finally {
            setSaving(false);
        }
    };

    const commitAreaLabel = async () => {
        const trimmed = areaLabelDraft.trim();
        const current = prefs.area ?? DEFAULT_AREA_BBOX;
        if (trimmed === current.label) return;
        if (!trimmed) {
            setAreaLabelDraft(current.label);
            return;
        }
        await handleAreaChange({ ...current, label: trimmed });
    };

    const handleContinue = async () => {
        setSaving(true);
        setError(null);
        try {
            const hiddenExisting = prefs.tagIds.filter((id) => !eligibleTagIds.has(id));
            await setPrefs({ tagIds: [...hiddenExisting, ...tagsValue.selectedTagIds] });
            navigate(followPath, { replace: true });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save preferences');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="mx-auto max-w-2xl px-4 py-8">
            <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl font-semibold text-slate-900">Set your event preferences</h1>
                    <p className="mt-1 text-sm text-slate-600">
                        Pick the styles and formats you want surfaced first.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => navigate(followPath, { replace: true })}
                    disabled={saving}
                    aria-label="Skip preferences"
                    className="text-sm text-slate-500 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Skip
                </button>
            </div>

            {error && (
                <div className="mb-3 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    {error}
                </div>
            )}

            <section className="mb-4 border border-slate-200 bg-white p-4">
                <label className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Preferred tags
                </label>
                {loading ? (
                    <p className="text-sm text-slate-400">Loading tags…</p>
                ) : visibleGroups.length === 0 ? (
                    <p className="text-sm text-slate-500">No onboarding tags are available yet.</p>
                ) : (
                    <TagsPicker
                        tagGroups={visibleGroups}
                        value={tagsValue}
                        onChange={setTagsValue}
                        allowFreeText={false}
                        searchable
                    />
                )}
            </section>

            <section className="mb-5 border border-slate-200 bg-white p-4">
                <button
                    type="button"
                    onClick={() => setAreaExpanded((v) => !v)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                    aria-expanded={areaExpanded}
                >
                    <span>
                        <span className="block text-sm font-semibold text-slate-900">Map view preferences</span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                            {prefs.area?.label ?? 'Use the default area'}
                        </span>
                    </span>
                    <span className="text-xs text-slate-400" aria-hidden="true">{areaExpanded ? '▾' : '▸'}</span>
                </button>

                {areaExpanded && (
                    <div className="mt-3">
                        <AreaMapPicker
                            value={prefs.area}
                            onChange={handleAreaChange}
                            onUseCurrentView={() => {
                                window.setTimeout(() => {
                                    const el = areaNameInputRef.current;
                                    if (el) {
                                        el.focus();
                                        el.select();
                                    }
                                }, 0);
                            }}
                        />
                        <div className="mt-2 flex items-center gap-2">
                            <label htmlFor="onboarding-area-name" className="shrink-0 text-[11px] text-slate-500">
                                Saved as
                            </label>
                            <input
                                id="onboarding-area-name"
                                ref={areaNameInputRef}
                                type="text"
                                value={areaLabelDraft}
                                onChange={(e) => setAreaLabelDraft(e.target.value)}
                                onBlur={() => { void commitAreaLabel(); }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        e.currentTarget.blur();
                                    }
                                }}
                                maxLength={10}
                                placeholder="Name"
                                size={12}
                                className="w-28 shrink-0 border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                        </div>
                    </div>
                )}
            </section>

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={() => void handleContinue()}
                    disabled={saving}
                    className="bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Continue'}
                </button>
            </div>
        </div>
    );
}
