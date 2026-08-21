import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchTagGroups } from '../api';
import type { TagGroup } from '../types';
import { usePreferences } from '../context/PreferencesContext';
import { useAuth } from '../context/AuthContext';
import ProfileEditor from './ProfileEditor';
import InterestProfilesManager from './InterestProfilesManager';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import { type TagsPickerValue } from './TagsPicker';
import type { PreferredAreaPayload } from '../api';

/**
 * Renders the "Preferences" editor (preferred dance/reach tags + preferred
 * map area) on the Settings page. Used by both anonymous and authenticated
 * users — the component talks to {@link usePreferences} which transparently
 * persists to localStorage (anon) or the server (authed).
 *
 * Anonymous users get the shared {@link ProfileEditor} (same wording, map
 * event pins, and "In your area" samples as onboarding). Signed-in users see
 * the {@link InterestProfilesManager} instead. Free-text tag suggestions are
 * disabled — prefs only reference existing tags. The section is collapsible
 * to keep the Settings page compact.
 */
export default function PreferencesSection() {
    const { prefs, setPrefs, clearPrefs, hasSetPrefs } = usePreferences();
    const { user } = useAuth();
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [loading, setLoading] = useState(true);
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

    const danceGroup = useMemo(
        () => tagGroups.find((g) => g.slug === 'dance-style' && g.enabled !== false) ?? null,
        [tagGroups],
    );
    const reachGroup = useMemo(
        () => tagGroups.find((g) => g.slug === 'reach' && g.enabled !== false) ?? null,
        [tagGroups],
    );
    const localTagId = useMemo(
        () => reachGroup?.tags.find((t) => t.slug === 'local')?.id ?? null,
        [reachGroup],
    );

    const danceValue = useMemo<TagsPickerValue>(
        () => ({
            selectedTagIds: danceGroup ? prefs.tagIds.filter((id) => danceGroup.tags.some((t) => t.id === id)) : [],
            freeTexts: {},
        }),
        [prefs.tagIds, danceGroup],
    );
    const reachValue = useMemo<TagsPickerValue>(
        () => ({
            selectedTagIds: reachGroup ? prefs.tagIds.filter((id) => reachGroup.tags.some((t) => t.id === id)) : [],
            freeTexts: {},
        }),
        [prefs.tagIds, reachGroup],
    );

    const flushTags = async (tagIds: number[]) => {
        setSaving(true);
        setError(null);
        try {
            await setPrefs({ tagIds });
            showSavedToast();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save preferences');
        } finally {
            setSaving(false);
        }
    };

    // Replace only this group's ids in prefs, preserving tags from other
    // groups so switching dance/reach never drops the rest.
    const handleDanceChange = (next: TagsPickerValue) => {
        const preserved = prefs.tagIds.filter((id) => !(danceGroup?.tags.some((t) => t.id === id) ?? false));
        void flushTags([...preserved, ...next.selectedTagIds]);
    };
    const handleReachChange = (next: TagsPickerValue) => {
        const preserved = prefs.tagIds.filter((id) => !(reachGroup?.tags.some((t) => t.id === id) ?? false));
        void flushTags([...preserved, ...next.selectedTagIds]);
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
            await clearPrefs();
            showSavedToast();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to clear preferences');
        } finally {
            setSaving(false);
        }
    };

    return (
        <section
            className="border border-line bg-surface p-4 mb-6"
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
                    <span className="text-muted text-xs" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                    <h2 className="text-sm font-semibold text-ink">
                        {user ? 'Discovery Profiles' : 'Preferences'}
                    </h2>
                </span>
                <span className="text-[11px] text-muted" role="status" aria-live="polite">
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
                            <p className="text-xs text-ink-soft mb-3">
                                These tags and map area are used as your starting event filters.
                            </p>

                            {loading ? (
                                <p className="text-xs text-muted">Loading…</p>
                            ) : (
                                <ProfileEditor
                                    danceGroup={danceGroup}
                                    reachGroup={reachGroup}
                                    localTagId={localTagId}
                                    danceValue={danceValue}
                                    reachValue={reachValue}
                                    onDanceChange={handleDanceChange}
                                    onReachChange={handleReachChange}
                                    area={prefs.area}
                                    onAreaChange={handleAreaChange}
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
                                    saving={saving}
                                    showMatchesToggle={false}
                                    areaNameControl={(
                                        <div className="flex shrink-0 items-center gap-2">
                                            <label htmlFor="pref-area-name" className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">
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
                                                className="w-28 border border-line bg-surface px-2 py-1.5 text-xs text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                                                data-testid="preferences-area-name"
                                            />
                                            <span
                                                className={`text-[11px] transition-opacity ${areaSavedFlash ? 'text-success opacity-100' : 'opacity-0'}`}
                                                role="status"
                                                aria-live="polite"
                                            >
                                                Saved
                                            </span>
                                        </div>
                                    )}
                                />
                            )}

                            {error && <p className="text-xs text-danger mb-2">{error}</p>}

                            {hasSetPrefs && (
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        onClick={handleClearAll}
                                        disabled={saving}
                                        className="border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50"
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
