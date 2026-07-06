import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchTagGroups } from '../api';
import type { TagGroup } from '../types';
import { usePreferences } from '../context/PreferencesContext';
import { useAuth } from '../context/AuthContext';
import AreaMapPicker from './AreaMapPicker';
import InterestProfilesManager from './InterestProfilesManager';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import TagsPicker, { type TagsPickerValue } from './TagsPicker';
import type { PreferredAreaPayload } from '../api';

/**
 * Renders the "Preferences" editor (preferred tags + preferred map area) on
 * the Settings page. Used by both anonymous and authenticated users — the
 * component talks to {@link usePreferences} which transparently persists to
 * localStorage (anon) or the server (authed).
 *
 * The tag UI reuses the admin event-side-panel picker (`TagsPicker`) so
 * users get the same searchable, group-coloured, scrollable card. Free-text
 * suggestions are disabled here — prefs only reference existing tags.
 *
 * Edits autosave: tag toggles persist after a short debounce; area edits
 * commit immediately when the user clicks an explicit AreaMapPicker action
 * or renames the saved area. The whole section is collapsible to keep the
 * Settings page compact.
 */
const TAG_AUTOSAVE_DEBOUNCE_MS = 600;

export default function PreferencesSection() {
    const { prefs, setPrefs, clearPrefs, hasSetPrefs } = usePreferences();
    const { user } = useAuth();
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [loading, setLoading] = useState(true);
    // Local optimistic mirror of selected tag ids. Drives the chip UI and
    // feeds the debounced autosave. Re-synced from ``prefs.tagIds`` whenever
    // the stored prefs change beneath us (sign-in hydrate, "Save as my
    // defaults" clicked elsewhere) — but suppressed while a local edit is
    // pending so the user's toggle doesn't visually flicker.
    const [tagsValue, setTagsValue] = useState<TagsPickerValue>(() => ({
        selectedTagIds: [...prefs.tagIds],
        freeTexts: {},
    }));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [savedToast, setSavedToast] = useState(false);
    const [areaSavedFlash, setAreaSavedFlash] = useState(false);
    // Collapsible body — default open so first-time visitors see the editor,
    // but the user can fold it away to reclaim vertical space.
    const [expanded, setExpanded] = useState(true);
    // Local draft of the saved area's label so the user can rename it
    // without re-picking the bbox. Synced from ``prefs.area`` and committed
    // via setPrefs on blur / Enter.
    const [areaLabelDraft, setAreaLabelDraft] = useState<string>(() => prefs.area?.label ?? DEFAULT_AREA_BBOX.label);

    const pendingTagFlushRef = useRef(false);
    const debounceTimerRef = useRef<number | null>(null);
    const toastTimerRef = useRef<number | null>(null);
    const areaSavedTimerRef = useRef<number | null>(null);
    const areaNameInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        fetchTagGroups()
            .then(setTagGroups)
            .catch(() => setTagGroups([]))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (pendingTagFlushRef.current) return;
        setTagsValue({ selectedTagIds: [...prefs.tagIds], freeTexts: {} });
    }, [prefs.tagIds]);

    useEffect(() => {
        setAreaLabelDraft(prefs.area?.label ?? DEFAULT_AREA_BBOX.label);
    }, [prefs.area]);

    const showSavedToast = () => {
        setSavedToast(true);
        if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setSavedToast(false), 2500);
    };

    const flashAreaSaved = () => {
        setAreaSavedFlash(true);
        if (areaSavedTimerRef.current != null) window.clearTimeout(areaSavedTimerRef.current);
        areaSavedTimerRef.current = window.setTimeout(() => setAreaSavedFlash(false), 2000);
    };

    const flushTags = async (tagIds: number[]) => {
        setSaving(true);
        setError(null);
        try {
            await setPrefs({ tagIds });
            showSavedToast();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save preferences');
        } finally {
            pendingTagFlushRef.current = false;
            setSaving(false);
        }
    };

    const handleTagsChange = (next: TagsPickerValue) => {
        setTagsValue(next);
        pendingTagFlushRef.current = true;
        if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
        const snapshot = [...next.selectedTagIds];
        debounceTimerRef.current = window.setTimeout(() => {
            void flushTags(snapshot);
        }, TAG_AUTOSAVE_DEBOUNCE_MS);
    };

    // Map-triggered area edits reset the label to "Custom" (per remark:
    // a moved area is no longer the previously named place). Renames go
    // through commitAreaLabel and preserve the typed name.
    const handleAreaChange = async (next: PreferredAreaPayload | null) => {
        setSaving(true);
        setError(null);
        try {
            const withLabel = next ? { ...next, label: 'Custom' } : null;
            if (withLabel && withLabel.label !== areaLabelDraft) {
                setAreaLabelDraft(withLabel.label);
            }
            await setPrefs({ area: withLabel });
            showSavedToast();
            flashAreaSaved();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save preferences');
        } finally {
            setSaving(false);
        }
    };

    const commitAreaLabel = async () => {
        const trimmed = areaLabelDraft.trim();
        // Effective area: persisted prefs.area, else the implicit default.
        const current = prefs.area ?? DEFAULT_AREA_BBOX;
        if (trimmed === current.label) return;
        // Empty input: leave the draft untouched so the user can keep
        // typing. Don't clobber the visual with the previous label.
        if (!trimmed) return;
        setSaving(true);
        setError(null);
        try {
            await setPrefs({ area: { ...current, label: trimmed } });
            showSavedToast();
            flashAreaSaved();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save preferences');
        } finally {
            setSaving(false);
        }
    };

    const handleClearAll = async () => {
        setSaving(true);
        setError(null);
        try {
            if (debounceTimerRef.current) {
                window.clearTimeout(debounceTimerRef.current);
                debounceTimerRef.current = null;
            }
            pendingTagFlushRef.current = false;
            await clearPrefs();
            setTagsValue({ selectedTagIds: [], freeTexts: {} });
            showSavedToast();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to clear preferences');
        } finally {
            setSaving(false);
        }
    };

    const visibleGroups = useMemo(
        () => tagGroups.filter((g) => g.enabled !== false && g.tags.some((t) => t.enabled !== false)),
        [tagGroups],
    );

    return (
        <section
            className="border border-slate-200 bg-white p-4 mb-6"
            data-testid="preferences-section"
        >
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="w-full flex items-baseline justify-between gap-4 text-left"
                aria-expanded={expanded}
                data-testid="preferences-toggle"
            >
                <span className="flex items-center gap-2">
                    <span className="text-slate-400 text-xs" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                    <h2 className="text-sm font-semibold text-slate-900">
                        {user ? 'Search Profiles' : 'Preferences'}
                    </h2>
                </span>
                <span className="text-[11px] text-slate-400" role="status" aria-live="polite">
                    {saving ? 'Saving…' : savedToast ? 'Saved.' : hasSetPrefs ? 'Saved' : ''}
                </span>
            </button>
            {expanded && (
                <div className="mt-3">
                    {user ? (
                        // Signed-in: the interest-profiles manager is the
                        // source of truth. The active profile is mirrored
                        // into legacy prefs for Explorer/For You, so we
                        // don't render the standalone tag/area editors
                        // here to avoid duplicate/confusing UI.
                        <InterestProfilesManager />
                    ) : (
                        <>
                            <p className="text-xs text-slate-600 mb-3">
                                These tags and map area are used as your starting event filters.
                            </p>

                            {/* ── Preferred tags (all enabled groups) ── */}
                            <div className="mb-4">
                                <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-1.5">
                                    Preferred tags
                                </label>
                                {loading ? (
                                    <p className="text-xs text-slate-400">Loading…</p>
                                ) : visibleGroups.length === 0 ? (
                                    <p className="text-xs text-slate-400">No tags available.</p>
                                ) : (
                                    <div
                                        className="border border-slate-200 bg-white max-h-72 overflow-y-auto p-3"
                                        data-testid="preferences-tags-card"
                                    >
                                        <TagsPicker
                                            tagGroups={visibleGroups}
                                            value={tagsValue}
                                            onChange={handleTagsChange}
                                            allowFreeText={false}
                                            searchable
                                        />
                                    </div>
                                )}
                            </div>

                            {/* ── Default event area ── */}
                            <div className="mb-3">
                                <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-1.5">
                                    Default event area
                                </label>
                                <AreaMapPicker
                                    value={prefs.area}
                                    onChange={handleAreaChange}
                                    autoSave
                                    onUseCurrentView={() => {
                                        // Defer until after the area save commits.
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
                                            <label htmlFor="pref-area-name" className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                                Name
                                            </label>
                                            <input
                                                id="pref-area-name"
                                                ref={areaNameInputRef}
                                                type="text"
                                                value={areaLabelDraft}
                                                onChange={(e) => setAreaLabelDraft(e.target.value)}
                                                onBlur={() => { void commitAreaLabel(); }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        (e.currentTarget as HTMLInputElement).blur();
                                                    }
                                                }}
                                                maxLength={10}
                                                placeholder="Area name"
                                                size={12}
                                                className="w-28 border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                data-testid="preferences-area-name"
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

                            {error && <p className="text-xs text-red-700 mb-2">{error}</p>}

                            {hasSetPrefs && (
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        onClick={handleClearAll}
                                        disabled={saving}
                                        className="border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                        data-testid="preferences-clear"
                                    >
                                        Clear all preferences
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </section>
    );
}
