import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
    createInterestProfile,
    fetchInterestProfiles,
    fetchTagGroups,
    updateInterestProfile,
    type PreferredAreaPayload,
} from '../api';
import AreaMapPicker from '../components/AreaMapPicker';
import TagsPicker, { type TagsPickerValue } from '../components/TagsPicker';
import { DEFAULT_AREA_BBOX, isWideArea } from '../constants/area';
import { usePreferences } from '../context/PreferencesContext';
import type { TagGroup } from '../types';

const GUARDRAIL_MESSAGE =
    'Large area: alerts and explorer results will include all local events. Narrow the Reach to focus.';

export default function OnboardingPreferences() {
    const navigate = useNavigate();
    const [sp] = useSearchParams();
    const next = sp.get('next') || '/';
    // After creating the profile, walk the user through the optional
    // local-area step. Skip also lands there so users always get the
    // chance to add a narrower local footprint.
    const localPath = `/onboarding/local?next=${encodeURIComponent(next)}`;
    const { prefs, setPrefs } = usePreferences();
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [danceValue, setDanceValue] = useState<TagsPickerValue>({
        selectedTagIds: [],
        freeTexts: {},
    });
    const [reachValue, setReachValue] = useState<TagsPickerValue>({
        selectedTagIds: [],
        freeTexts: {},
    });
    const [areaExpanded, setAreaExpanded] = useState(true);
    const [areaLabelDraft, setAreaLabelDraft] = useState(prefs.area?.label ?? DEFAULT_AREA_BBOX.label);
    const [matchesEnabled, setMatchesEnabled] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [areaSavedFlash, setAreaSavedFlash] = useState(false);
    const areaSavedTimerRef = useRef<number | null>(null);
    const flashAreaSaved = () => {
        setAreaSavedFlash(true);
        if (areaSavedTimerRef.current != null) window.clearTimeout(areaSavedTimerRef.current);
        areaSavedTimerRef.current = window.setTimeout(() => setAreaSavedFlash(false), 2000);
    };
    const areaNameInputRef = useRef<HTMLInputElement | null>(null);
    const initialTagIdsRef = useRef(prefs.tagIds);
    const reachInitializedRef = useRef(false);
    // Name-draft debounce: renaming should also auto-save (matching the
    // map auto-save behavior), so users don't need an explicit action.
    const nameDebounceRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchTagGroups({ scope: 'event', onboarding: true })
            .then((groups) => {
                if (cancelled) return;
                setTagGroups(groups);
            })
            .catch(() => {
                if (!cancelled) setTagGroups([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const danceGroup = useMemo(
        () => tagGroups.find((g) => g.slug === 'dance-style' && g.enabled !== false) ?? null,
        [tagGroups],
    );
    const reachGroup = useMemo(
        () => tagGroups.find((g) => g.slug === 'reach' && g.enabled !== false) ?? null,
        [tagGroups],
    );
    const internationalTagId = useMemo(
        () => reachGroup?.tags.find((t) => t.slug === 'international')?.id ?? null,
        [reachGroup],
    );
    const localTagId = useMemo(
        () => reachGroup?.tags.find((t) => t.slug === 'local')?.id ?? null,
        [reachGroup],
    );

    // Seed dance & reach selections from stored prefs.tagIds (split by group)
    // and pre-select the reach 'international' tag on first load per PRD.
    useEffect(() => {
        if (loading || reachInitializedRef.current) return;
        if (!danceGroup && !reachGroup) return;
        const danceIds = danceGroup
            ? danceGroup.tags.filter((t) => initialTagIdsRef.current.includes(t.id)).map((t) => t.id)
            : [];
        const reachIdsFromPrefs = reachGroup
            ? reachGroup.tags.filter((t) => initialTagIdsRef.current.includes(t.id)).map((t) => t.id)
            : [];
        const reachIds =
            reachIdsFromPrefs.length === 0 && internationalTagId != null
                ? [internationalTagId]
                : reachIdsFromPrefs;
        setDanceValue({ selectedTagIds: danceIds, freeTexts: {} });
        setReachValue({ selectedTagIds: reachIds, freeTexts: {} });
        reachInitializedRef.current = true;
    }, [loading, danceGroup, reachGroup, internationalTagId]);

    const currentArea = prefs.area ?? DEFAULT_AREA_BBOX;
    const draftIsWide = isWideArea(currentArea);
    const draftReachIncludesLocalOrEmpty =
        reachValue.selectedTagIds.length === 0 ||
        (localTagId != null && reachValue.selectedTagIds.includes(localTagId));
    const showGuardrailHint = draftIsWide && draftReachIncludesLocalOrEmpty;

    const handleAreaChange = async (nextArea: PreferredAreaPayload | null) => {
        setSaving(true);
        setError(null);
        // Whenever the map area changes, reset the label (per remark: an
        // area is no longer the previously named place once the user moves
        // the map). Onboarding always edits the account's default profile,
        // so it resets to "Default" rather than "Custom". The user can
        // rename afterwards via the name input.
        const label = 'Default';
        const withLabel = nextArea ? { ...nextArea, label } : null;
        if (label !== areaLabelDraft) setAreaLabelDraft(label);
        try {
            await setPrefs({ area: withLabel });
            flashAreaSaved();
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
        // Empty input: leave the draft untouched so the user can keep
        // typing. We only commit non-empty renames; the map path handles
        // the default fallback to "Default" when the area actually changes.
        if (!trimmed) return;
        setSaving(true);
        setError(null);
        try {
            await setPrefs({ area: { ...current, label: trimmed } });
            flashAreaSaved();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save map preferences');
        } finally {
            setSaving(false);
        }
    };

    // Debounced auto-save while typing in the name box: no explicit
    // blur/enter required. Fires when the trimmed value differs from the
    // current saved label.
    useEffect(() => {
        if (nameDebounceRef.current != null) window.clearTimeout(nameDebounceRef.current);
        nameDebounceRef.current = window.setTimeout(() => { void commitAreaLabel(); }, 700);
        return () => {
            if (nameDebounceRef.current != null) window.clearTimeout(nameDebounceRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [areaLabelDraft]);

    const handleContinue = async () => {
        setSaving(true);
        setError(null);
        try {
            const danceIds = danceValue.selectedTagIds;
            const reachIds = reachValue.selectedTagIds;
            const area = prefs.area ?? DEFAULT_AREA_BBOX;
            const otherTagIds = prefs.tagIds.filter((id) => {
                const inDance = danceGroup?.tags.some((t) => t.id === id) ?? false;
                const inReach = reachGroup?.tags.some((t) => t.id === id) ?? false;
                return !inDance && !inReach;
            });
            // Mirror the profile's tag selection into legacy BROWSE prefs so
            // Explorer/Calendar respect the same taste out-of-the-box.
            await setPrefs({
                area,
                tagIds: [...otherTagIds, ...danceIds, ...reachIds],
            });
            // Signup seeded a default profile (matches_enabled=false,
            // is_active=true). Prefer PATCHing that row so we don't
            // accumulate stale duplicates; only POST if backfill missed
            // this user (e.g. legacy account before the migration).
            const existing = await fetchInterestProfiles().catch(() => [] as never);
            const target = Array.isArray(existing)
                ? existing.find((p) => p.is_active) ?? existing[0] ?? null
                : null;
            const profilePayload = {
                label: area.label,
                min_lat: area.min_lat,
                min_lng: area.min_lng,
                max_lat: area.max_lat,
                max_lng: area.max_lng,
                dance_tag_ids: danceIds,
                reach_tag_ids: reachIds,
                matches_enabled: matchesEnabled,
                is_active: true,
            };
            if (target) {
                await updateInterestProfile(target.id, profilePayload);
            } else {
                await createInterestProfile(profilePayload);
            }
            navigate(localPath, { replace: true });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save preferences');
        } finally {
            setSaving(false);
        }
    };

    const canContinue = !loading && !saving && danceValue.selectedTagIds.length > 0;

    // Skip is a pure navigate: signup already seeded the default profile
    // with ``matches_enabled=false``, so no side-effect is needed here.
    // The user can flip notifications on later from Settings.
    // We still route through the local-profile step so users always get
    // the chance to add a narrower local area (with their dance styles
    // pre-filled, if they picked any before skipping).
    const handleSkip = () => {
        navigate(localPath, { replace: true });
    };

    return (
        <div className="mx-auto max-w-2xl px-4 py-4">
            <div className="mb-3 flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-lg font-semibold text-slate-900">Create your active profile</h1>
                    <p className="mt-0.5 text-xs text-slate-600">
                        Your active profile filters what you see in the Explorer and drives your alerts. Pick your dance styles and where you're open to travel.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleSkip}
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

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Dance styles
                </label>
                {loading ? (
                    <p className="text-sm text-slate-400">Loading tags…</p>
                ) : !danceGroup ? (
                    <p className="text-sm text-slate-500">No dance-style tags are available yet.</p>
                ) : (
                    <TagsPicker
                        tagGroups={[danceGroup]}
                        value={danceValue}
                        onChange={setDanceValue}
                        allowFreeText={false}
                        searchable
                    />
                )}
            </section>

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Reach
                </label>
                <p className="mb-1.5 text-xs text-slate-500">
                    Event scale you want alerts about. Leave empty to match any scale.
                </p>
                {loading ? (
                    <p className="text-sm text-slate-400">Loading…</p>
                ) : !reachGroup ? (
                    <p className="text-sm text-slate-500">No reach tags are available yet.</p>
                ) : (
                    <TagsPicker
                        tagGroups={[reachGroup]}
                        value={reachValue}
                        onChange={setReachValue}
                        allowFreeText={false}
                        searchable={false}
                    />
                )}
            </section>

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <button
                    type="button"
                    onClick={() => setAreaExpanded((v) => !v)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                    aria-expanded={areaExpanded}
                >
                    <span>
                        <span className="block text-sm font-semibold text-slate-900">Where to look</span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                            {prefs.area?.label ?? `Events start around ${DEFAULT_AREA_BBOX.label}`}
                        </span>
                    </span>
                    <span className="text-xs text-slate-400" aria-hidden="true">{areaExpanded ? '▾' : '▸'}</span>
                </button>

                {areaExpanded && (
                    <div className="mt-2">
                        <p className="mb-2 text-xs text-slate-600">
                            This sets the area your alert covers. It does not share your location.
                        </p>
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
                            controlsStart={(
                                <div className="flex shrink-0 items-center gap-2">
                                    <label htmlFor="onboarding-area-name" className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                        Name
                                    </label>
                                    <input
                                        id="onboarding-area-name"
                                        ref={areaNameInputRef}
                                        type="text"
                                        value={areaLabelDraft}
                                        onChange={(e) => setAreaLabelDraft(e.target.value)}
                                        maxLength={10}
                                        placeholder="Area name"
                                        size={12}
                                        className="w-28 border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                    <span
                                        className={`text-[11px] transition-opacity ${areaSavedFlash ? 'text-emerald-600 opacity-100' : 'opacity-0'}`}
                                        role="status"
                                        aria-live="polite"
                                    >
                                        Saved
                                    </span>
                                </div>
                            )}
                        />
                    </div>
                )}
            </section>

            {showGuardrailHint && (
                <p className="mb-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {GUARDRAIL_MESSAGE}
                </p>
            )}

            <section className="mb-3 border border-slate-200 bg-white p-3">
                <label className="flex items-start gap-3 text-sm text-slate-800">
                    <input
                        type="checkbox"
                        checked={matchesEnabled}
                        onChange={(e) => setMatchesEnabled(e.target.checked)}
                        className="mt-0.5 h-4 w-4"
                    />
                    <span>
                        <span className="block font-medium">Notify me about matching events</span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                            Get an email when a new event matches this profile. You can change this later.
                        </span>
                    </span>
                </label>
            </section>

            <p className="mb-2 text-xs text-slate-500">
                You can edit or add profiles in Settings.
            </p>

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={() => void handleContinue()}
                    disabled={!canContinue}
                    className="bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Continue'}
                </button>
            </div>
        </div>
    );
}
