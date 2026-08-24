/**
 * Onboarding, restyled as a single stepped wizard that mirrors the review
 * workflow (RateEventModal): one card, a progress bar, a back/continue
 * footer, and a final recap whose sections jump back to their step. It
 * replaces the former three-route flow (preferences → local → follow) while
 * reusing the same pickers (TagsPicker, AreaMapPicker), follow suggestions,
 * and preferences persistence.
 *
 * Soft gate: finishing the first step (dance styles) stamps ``onboarded_at``
 * via ``completeOnboarding([])`` so the user is released into the app right
 * away; the remaining steps become optional nudges rather than a hard wall.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CircleMarker, MapContainer, Rectangle, TileLayer, useMap } from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';
import {
    completeOnboarding,
    createInterestProfile,
    deleteInterestProfile,
    fetchInterestProfiles,
    fetchOnboardingSuggestions,
    fetchPopularCities,
    fetchTagGroups,
    followUser,
    geolocateFromIP,
    searchSuggestionAddress,
    searchUsers,
    unfollowUser,
    updateInterestProfile,
    type GeocodeSuggestion,
    type HomeLocationPayload,
    type PopularCity,
    type PreferredAreaPayload,
    type UserSearchResult,
} from '../api';
import ProfileEditor from '../components/ProfileEditor';
import TagsPicker, { type TagsPickerValue } from '../components/TagsPicker';
import { clampArea, DEFAULT_AREA_BBOX } from '../constants/area';
import { useAuth } from '../context/AuthContext';
import { usePreferences } from '../context/PreferencesContext';
import type { Tag, TagGroup } from '../types';
export { default } from '../components/onboarding/OnboardingFlow';

const RADIUS_MIN_KM = 5;
const RADIUS_MAX_KM = 150;
const RADIUS_DEFAULT_KM = 10;
const SUGGESTION_LIMIT = 7;

type StepKey = 'styles' | 'area' | 'follow' | 'local' | 'recap';
const STEPS: StepKey[] = ['styles', 'area', 'follow', 'local', 'recap'];

type FollowStatus = 'idle' | 'following' | 'unfollowing' | 'followed' | 'requested' | 'error';

/** Square-ish bbox centered on ``pin`` covering ``radiusKm`` each way.
 * Longitude spans shrink toward the poles, corrected with cos(lat). */
function bboxFromPinRadius(pin: { lat: number; lng: number }, radiusKm: number, label: string): PreferredAreaPayload {
    const latRad = (pin.lat * Math.PI) / 180;
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.max(0.1, Math.cos(latRad)));
    return clampArea({
        min_lat: pin.lat - dLat,
        min_lng: pin.lng - dLng,
        max_lat: pin.lat + dLat,
        max_lng: pin.lng + dLng,
        label,
    });
}

/** Recenters the Leaflet map imperatively when the pin/radius changes. */
function MapRecenter({ pin, radiusKm }: { pin: { lat: number; lng: number }; radiusKm: number }) {
    const map = useMap();
    useEffect(() => {
        const bbox = bboxFromPinRadius(pin, radiusKm, 'preview');
        map.fitBounds(
            [
                [bbox.min_lat, bbox.min_lng],
                [bbox.max_lat, bbox.max_lng],
            ],
            { padding: [20, 20], animate: true },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps -- recenter on coordinate change, not object identity.
    }, [map, pin.lat, pin.lng, radiusKm]);
    return null;
}

export function LegacyOnboardingWizard() {
    const navigate = useNavigate();
    const [sp] = useSearchParams();
    const next = sp.get('next') || '/';
    const { prefs, setPrefs } = usePreferences();
    const { refreshUser } = useAuth();

    const [stepIndex, setStepIndex] = useState(0);
    // When an "Edit" jumps back to a step, its Continue returns to the origin
    // step (recap, or the preview step) instead of walking forward.
    const [returnTo, setReturnTo] = useState<StepKey | null>(null);
    const [error, setError] = useState<string | null>(null);

    // --- tag groups (shared by styles + area + local) --------------------
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [tagsLoading, setTagsLoading] = useState(true);
    useEffect(() => {
        let cancelled = false;
        fetchTagGroups({ scope: 'event', onboarding: true })
            .then((groups) => { if (!cancelled) setTagGroups(groups); })
            .catch(() => { if (!cancelled) setTagGroups([]); })
            .finally(() => { if (!cancelled) setTagsLoading(false); });
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

    // --- step 1 (styles) + step 2 (reach) selections ---------------------
    const [danceValue, setDanceValue] = useState<TagsPickerValue>({ selectedTagIds: [], freeTexts: {} });
    const [reachValue, setReachValue] = useState<TagsPickerValue>({ selectedTagIds: [], freeTexts: {} });
    const [matchesEnabled, setMatchesEnabled] = useState(true);
    const initialTagIdsRef = useRef(prefs.tagIds);
    const seededRef = useRef(false);
    useEffect(() => {
        if (tagsLoading || seededRef.current) return;
        if (!danceGroup && !reachGroup) return;
        const danceIds = danceGroup
            ? danceGroup.tags.filter((t) => initialTagIdsRef.current.includes(t.id)).map((t) => t.id)
            : [];
        const reachFromPrefs = reachGroup
            ? reachGroup.tags.filter((t) => initialTagIdsRef.current.includes(t.id)).map((t) => t.id)
            : [];
        const reachIds =
            reachFromPrefs.length === 0 && internationalTagId != null ? [internationalTagId] : reachFromPrefs;
        setDanceValue({ selectedTagIds: danceIds, freeTexts: {} });
        setReachValue({ selectedTagIds: reachIds, freeTexts: {} });
        seededRef.current = true;
    }, [tagsLoading, danceGroup, reachGroup, internationalTagId]);

    // --- default area (step 2) -------------------------------------------
    const [areaLabelDraft, setAreaLabelDraft] = useState(prefs.area?.label ?? DEFAULT_AREA_BBOX.label);
    const [savingArea, setSavingArea] = useState(false);
    const areaNameRef = useRef<HTMLInputElement | null>(null);
    const geoPrefilledRef = useRef(false);
    // Best-effort geo-IP center so the area step is confirm-not-configure.
    useEffect(() => {
        if (prefs.area || geoPrefilledRef.current) return;
        geoPrefilledRef.current = true;
        geolocateFromIP()
            .then((loc) => {
                if (!loc) return;
                const bbox = bboxFromPinRadius({ lat: loc.lat, lng: loc.lng }, 60, loc.label || 'Default');
                void setPrefs({ area: bbox });
            })
            .catch(() => { /* fall back to default footprint */ });
    }, [prefs.area, setPrefs]);

    const handleAreaChange = async (nextArea: PreferredAreaPayload | null) => {
        setSavingArea(true);
        setError(null);
        const label = nextArea?.label ?? 'Custom area';
        const withLabel = nextArea ? { ...nextArea, label } : null;
        if (label !== areaLabelDraft) setAreaLabelDraft(label);
        try {
            await setPrefs({ area: withLabel });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save map preferences');
        } finally {
            setSavingArea(false);
        }
    };

    const nameDebounceRef = useRef<number | null>(null);
    useEffect(() => {
        if (nameDebounceRef.current != null) window.clearTimeout(nameDebounceRef.current);
        nameDebounceRef.current = window.setTimeout(() => {
            const trimmed = areaLabelDraft.trim();
            const current = prefs.area ?? DEFAULT_AREA_BBOX;
            if (!trimmed || trimmed === current.label) return;
            void setPrefs({ area: { ...current, label: trimmed } });
        }, 700);
        return () => {
            if (nameDebounceRef.current != null) window.clearTimeout(nameDebounceRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [areaLabelDraft]);

    // --- live event preview (area step) ----------------------------------
    // Shared with the profile editors via useAreaEventPreview: one worldwide
    // fetch per style/reach selection powers the map pins and the trail.
    const danceIds = danceValue.selectedTagIds;
    const reachIds = reachValue.selectedTagIds;
    const onAreaStep = STEPS[stepIndex] === 'area';

    // Selected dance + reach tags as Tag objects for the step-2 badge recap.
    const selectedProfileTags = useMemo<Tag[]>(() => {
        const dance = danceGroup?.tags.filter((t) => danceIds.includes(t.id)) ?? [];
        const reach = reachGroup?.tags.filter((t) => reachIds.includes(t.id)) ?? [];
        return [...dance, ...reach];
    }, [danceGroup, reachGroup, danceIds, reachIds]);

    // --- follow step -----------------------------------------------------
    const [followItems, setFollowItems] = useState<UserSearchResult[] | null>(null);
    const [followStatus, setFollowStatus] = useState<Record<string, FollowStatus>>({});
    const [userSearch, setUserSearch] = useState('');
    const [userResults, setUserResults] = useState<UserSearchResult[]>([]);
    const [userSearching, setUserSearching] = useState(false);
    const followLoadedRef = useRef(false);
    useEffect(() => {
        if (followLoadedRef.current) return;
        followLoadedRef.current = true;
        fetchOnboardingSuggestions(SUGGESTION_LIMIT)
            .then((r) => {
                setFollowItems(r.items);
                setFollowStatus(Object.fromEntries(
                    r.items
                        .map((it) => [it.handle ?? '', it.is_followed_by_viewer ? 'followed' : 'idle'] as const)
                        .filter(([handle]) => Boolean(handle)),
                ));
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, []);

    useEffect(() => {
        const term = userSearch.trim();
        let cancelled = false;
        const timer = window.setTimeout(() => {
            if (term.length < 2) {
                setUserResults([]);
                setUserSearching(false);
                return;
            }
            searchUsers(term, { limit: 8 })
                .then((r) => { if (!cancelled) setUserResults(r.items); })
                .catch(() => { if (!cancelled) setUserResults([]); })
                .finally(() => { if (!cancelled) setUserSearching(false); });
        }, 250);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [userSearch]);

    const addToFollowList = useCallback((u: UserSearchResult) => {
        const handle = u.handle;
        if (!handle) return;
        setFollowItems((prev) => {
            const base = prev ?? [];
            if (base.some((it) => it.handle === handle)) return base;
            return [...base, u];
        });
        setUserSearch('');
        setUserResults([]);
    }, []);

    const handleFollowToggle = useCallback(async (u: UserSearchResult) => {
        const handle = u.handle;
        if (!handle) return;
        const current = followStatus[handle] ?? (u.is_followed_by_viewer ? 'followed' : 'idle');
        if (current === 'following' || current === 'unfollowing') return;
        addToFollowList(u);
        setError(null);
        try {
            const isFollowing = current === 'followed' || current === 'requested';
            setFollowStatus((prev) => ({ ...prev, [handle]: isFollowing ? 'unfollowing' : 'following' }));
            const result = isFollowing ? await unfollowUser(handle) : await followUser(handle);
            const nextStatus: FollowStatus = result.is_following
                ? result.follow_status === 'pending' ? 'requested' : 'followed'
                : 'idle';
            setFollowStatus((prev) => ({ ...prev, [handle]: nextStatus }));
            setFollowItems((prev) => (prev ?? []).map((it) => (
                it.handle === handle
                    ? { ...it, is_followed_by_viewer: result.is_following, is_friend: result.is_friend, is_subscribed: result.is_subscribed }
                    : it
            )));
            window.dispatchEvent(new Event('network:changed'));
        } catch (e) {
            setFollowStatus((prev) => ({ ...prev, [handle]: current }));
            setError(e instanceof Error ? e.message : 'Failed to update follow');
        }
    }, [addToFollowList, followStatus]);

    // Followed users (for the recap avatar row), preserving list order.
    const followedUsers = useMemo(
        () => (followItems ?? []).filter((u) => {
            const s = followStatus[u.handle ?? ''] ?? (u.is_followed_by_viewer ? 'followed' : 'idle');
            return s === 'followed' || s === 'requested';
        }),
        [followItems, followStatus],
    );

    // Follow from the search overlay: prepend to the suggestions list, then
    // follow. Dedupe keeps an existing entry in place.
    const followFromSearch = useCallback(async (u: UserSearchResult) => {
        const handle = u.handle;
        if (!handle) return;
        setFollowItems((prev) => {
            const base = prev ?? [];
            if (base.some((it) => it.handle === handle)) return base;
            return [u, ...base];
        });
        setUserSearch('');
        setUserResults([]);
        await handleFollowToggle(u);
    }, [handleFollowToggle]);

    // --- local step ------------------------------------------------------
    // No default pin: the user must explicitly pick a location so tapping
    // Continue never commits an unintended area.
    const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
    const [cityLabel, setCityLabel] = useState<string>('');
    const [radiusKm, setRadiusKm] = useState<number>(RADIUS_DEFAULT_KM);
    const [localDanceValue, setLocalDanceValue] = useState<TagsPickerValue>({ selectedTagIds: [], freeTexts: {} });
    const [localMatchesEnabled, setLocalMatchesEnabled] = useState(true);
    const localSeededRef = useRef(false);
    useEffect(() => {
        if (STEPS[stepIndex] !== 'local' || localSeededRef.current || !danceGroup) return;
        localSeededRef.current = true;
        const seeded = danceValue.selectedTagIds.filter((id) => danceGroup.tags.some((t) => t.id === id));
        setLocalDanceValue({ selectedTagIds: seeded, freeTexts: {} });
    }, [stepIndex, danceGroup, danceValue.selectedTagIds]);

    const [citySearch, setCitySearch] = useState('');
    const [citySuggestions, setCitySuggestions] = useState<GeocodeSuggestion[]>([]);
    const [citySearching, setCitySearching] = useState(false);
    const [citySuggestOpen, setCitySuggestOpen] = useState(false);
    const citySearchReqRef = useRef(0);
    const [popularCities, setPopularCities] = useState<PopularCity[]>([]);
    const [geoLoading, setGeoLoading] = useState(false);
    const [localCreated, setLocalCreated] = useState(false);
    const [localProfileId, setLocalProfileId] = useState<number | null>(null);

    useEffect(() => {
        fetchPopularCities(8).then(setPopularCities).catch(() => setPopularCities([]));
    }, []);

    useEffect(() => {
        const q = citySearch.trim();
        const reqId = ++citySearchReqRef.current;
        const timer = window.setTimeout(async () => {
            if (q.length < 2) {
                setCitySuggestions([]);
                setCitySearching(false);
                return;
            }
            setCitySearching(true);
            try {
                const results = await searchSuggestionAddress(q);
                if (reqId !== citySearchReqRef.current) return;
                setCitySuggestions(results.slice(0, 6));
                setCitySuggestOpen(true);
            } finally {
                if (reqId === citySearchReqRef.current) setCitySearching(false);
            }
        }, 300);
        return () => window.clearTimeout(timer);
    }, [citySearch]);

    const handleUseCurrentLocation = () => {
        if (!('geolocation' in navigator)) {
            setError('Geolocation is not available in this browser.');
            return;
        }
        setGeoLoading(true);
        setError(null);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setPin({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                setCityLabel('Local');
                setCitySearch('');
                setGeoLoading(false);
            },
            (err) => {
                setGeoLoading(false);
                setError(err.message || 'Could not read your current location.');
            },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
        );
    };

    const pickCity = (c: PopularCity) => {
        setPin({ lat: c.lat, lng: c.lng });
        setCityLabel(c.city);
        setCitySearch('');
    };

    const localBboxPreview = useMemo(() => {
        if (!pin) return null;
        return bboxFromPinRadius(pin, radiusKm, cityLabel.trim() || 'Local');
    }, [pin, radiusKm, cityLabel]);

    const localBboxBounds: LatLngBoundsExpression | null = localBboxPreview
        ? [
            [localBboxPreview.min_lat, localBboxPreview.min_lng],
            [localBboxPreview.max_lat, localBboxPreview.max_lng],
        ]
        : null;

    // --- navigation ------------------------------------------------------
    const step = STEPS[stepIndex];
    const softGateStampedRef = useRef(false);
    const stampSoftGate = useCallback(async () => {
        if (softGateStampedRef.current) return;
        softGateStampedRef.current = true;
        try {
            await completeOnboarding([]);
            await refreshUser();
        } catch {
            // Non-blocking: the follow step re-stamps, and the gate falls
            // back to nudges if this best-effort call fails.
            softGateStampedRef.current = false;
        }
    }, [refreshUser]);

    const goToReturn = () => {
        const target = returnTo ?? 'recap';
        setReturnTo(null);
        setStepIndex(STEPS.indexOf(target));
    };
    const goNext = () => {
        if (returnTo) { goToReturn(); return; }
        setStepIndex((i) => Math.min(STEPS.length - 1, i + 1));
    };
    const goBack = () => setStepIndex((i) => Math.max(0, i - 1));
    const jumpTo = (key: StepKey, from: StepKey = 'recap') => { setReturnTo(from); setStepIndex(STEPS.indexOf(key)); };

    const saveDefaultProfile = useCallback(async () => {
        const area = prefs.area ?? DEFAULT_AREA_BBOX;
        const otherTagIds = prefs.tagIds.filter((id) => {
            const inDance = danceGroup?.tags.some((t) => t.id === id) ?? false;
            const inReach = reachGroup?.tags.some((t) => t.id === id) ?? false;
            return !inDance && !inReach;
        });
        await setPrefs({ area, tagIds: [...otherTagIds, ...danceIds] });
        const existing = await fetchInterestProfiles().catch(() => [] as never);
        const target = Array.isArray(existing)
            ? existing.find((p) => p.is_active) ?? existing[0] ?? null
            : null;
        const payload = {
            label: target?.label ?? 'Default',
            area_label: area.label,
            min_lat: area.min_lat,
            min_lng: area.min_lng,
            max_lat: area.max_lat,
            max_lng: area.max_lng,
            dance_tag_ids: danceIds,
            reach_filter: 'international' as const,
            matches_enabled: matchesEnabled,
            is_active: true,
        };
        if (target) await updateInterestProfile(target.id, payload);
        else await createInterestProfile(payload);
    }, [prefs.area, prefs.tagIds, danceGroup, reachGroup, danceIds, reachIds, matchesEnabled, setPrefs]);

    const saveLocalProfile = useCallback(async () => {
        if (!pin || !localBboxPreview) return;
        const homePayload: HomeLocationPayload = { lat: pin.lat, lng: pin.lng, label: cityLabel.trim() || 'Local' };
        await setPrefs({ homeLocation: homePayload });
        const created = await createInterestProfile({
            label: 'Local events',
            area_label: localBboxPreview.label,
            min_lat: localBboxPreview.min_lat,
            min_lng: localBboxPreview.min_lng,
            max_lat: localBboxPreview.max_lat,
            max_lng: localBboxPreview.max_lng,
            dance_tag_ids: localDanceValue.selectedTagIds,
            reach_filter: 'any',
            matches_enabled: localMatchesEnabled,
            is_active: false,
        });
        setLocalProfileId(created.id);
        setLocalCreated(true);
    }, [pin, localBboxPreview, cityLabel, localDanceValue.selectedTagIds, localMatchesEnabled, setPrefs]);

    // Drops any persisted local profile + home location. Used by both the
    // in-step "Remove location" button and "Skip for now".
    const removeLocalProfile = useCallback(async () => {
        if (localProfileId != null) {
            try {
                await deleteInterestProfile(localProfileId);
                await setPrefs({ homeLocation: null });
            } catch { /* best-effort cleanup */ }
        }
        setLocalProfileId(null);
        setLocalCreated(false);
    }, [localProfileId, setPrefs]);

    const clearLocalLocation = useCallback(() => {
        setPin(null);
        setCityLabel('');
        setCitySearch('');
        setRadiusKm(RADIUS_DEFAULT_KM);
        void removeLocalProfile();
    }, [removeLocalProfile]);

    const [advancing, setAdvancing] = useState(false);
    const handleContinue = async () => {
        setError(null);
        setAdvancing(true);
        try {
            if (step === 'styles') {
                await setPrefs({ tagIds: mergeDanceIntoPrefs(prefs.tagIds, danceGroup, danceIds) });
                void stampSoftGate();
            } else if (step === 'area') {
                // Area was persisted live by the map picker; here we finalize
                // the default interest profile with the chosen alert setting.
                await saveDefaultProfile();
            } else if (step === 'local') {
                if (pin) await saveLocalProfile();
            } else if (step === 'recap') {
                navigate(next, { replace: true });
                return;
            }
            goNext();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
        } finally {
            setAdvancing(false);
        }
    };

    const handleSkip = () => {
        setError(null);
        // Skipping the local step must undo any profile created on a prior visit.
        if (step === 'local' && localCreated) void removeLocalProfile();
        goNext();
    };

    const canContinue = (() => {
        if (advancing) return false;
        if (step === 'styles') return !tagsLoading && danceIds.length > 0;
        if (step === 'local') return !!pin && localDanceValue.selectedTagIds.length > 0;
        return true;
    })();

    const showSkip = step === 'follow' || step === 'local';

    const stepTitle: Record<StepKey, string> = {
        styles: 'What do you dance?',
        area: 'Where do you dance?',
        follow: 'Build your tribe',
        local: 'A closer look near home?',
        recap: "You're all set",
    };
    const stepHint: Record<StepKey, string> = {
        styles: "Sets your default Explorer filter, For You feed and alerts.",
        area: 'Sets your default Explorer area and the region we alert you about for the selected tags.',
        follow: 'Follow a few people to see their calendars and activity.',
        local: 'Optional: add a tighter radius around home as a separate profile.',
        recap: 'Review your choices — edit anything before you dive in.',
    };

    return (
        <div className="mx-auto max-w-2xl px-4 py-4">
            <div className="border border-line bg-surface p-3">
                {/* Progress */}
                <div
                    className="flex items-center gap-1.5"
                    role="progressbar"
                    aria-valuemin={1}
                    aria-valuemax={STEPS.length}
                    aria-valuenow={stepIndex + 1}
                    aria-label={`Step ${stepIndex + 1} of ${STEPS.length}`}
                >
                    {STEPS.map((k, i) => (
                        <span
                            key={k}
                            className={`h-1.5 flex-1 transition ${i <= stepIndex ? 'bg-action' : 'bg-slate-200'}`}
                        />
                    ))}
                </div>

                {/* Header */}
                <div className="mt-3 flex items-center gap-2">
                    {stepIndex > 0 && (
                        <button
                            type="button"
                            onClick={goBack}
                            disabled={advancing}
                            aria-label="Back"
                            className="shrink-0 -ml-1 text-2xl leading-none text-ink-soft hover:text-ink disabled:opacity-50"
                        >
                            ←
                        </button>
                    )}
                    <h1 className="flex-1 text-base font-semibold text-ink">{stepTitle[step]}</h1>
                    <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted">
                        Step {stepIndex + 1} of {STEPS.length}
                    </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-soft">{stepHint[step]}</p>

                {error && (
                    <div className="mt-3 border border-line bg-canvas px-3 py-2 text-xs text-ink">
                        {error}
                    </div>
                )}

                <div className="mt-3 space-y-3">
                    {/* STEP: styles */}
                    {step === 'styles' && (
                        <>
                            <section>
                                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-soft">
                                    Dance styles
                                </label>
                                {tagsLoading ? (
                                    <p className="text-sm text-muted">Loading tags…</p>
                                ) : !danceGroup ? (
                                    <p className="text-sm text-ink-soft">No dance-style tags are available yet.</p>
                                ) : (
                                    <TagsPicker
                                        tagGroups={[danceGroup]}
                                        value={danceValue}
                                        onChange={setDanceValue}
                                        allowFreeText={false}
                                        searchable
                                        hideGroupLabels
                                    />
                                )}
                            </section>
                            <section>
                                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-soft">
                                    Event reach
                                </label>
                                {tagsLoading ? (
                                    <p className="text-sm text-muted">Loading…</p>
                                ) : !reachGroup ? (
                                    <p className="text-sm text-ink-soft">No reach tags are available yet.</p>
                                ) : (
                                    <TagsPicker
                                        tagGroups={[reachGroup]}
                                        value={reachValue}
                                        onChange={setReachValue}
                                        allowFreeText={false}
                                        searchable={false}
                                        hideGroupLabels
                                    />
                                )}
                            </section>
                        </>
                    )}

                    {/* STEP: area */}
                    {step === 'area' && (
                        <ProfileEditor
                            danceGroup={danceGroup}
                            reachGroup={reachGroup}
                            localTagId={localTagId}
                            danceValue={danceValue}
                            reachValue={reachValue}
                            onDanceChange={setDanceValue}
                            onReachChange={setReachValue}
                            area={prefs.area}
                            onAreaChange={handleAreaChange}
                            onUseCurrentView={() => areaNameRef.current?.focus()}
                            saving={savingArea}
                            matchesEnabled={matchesEnabled}
                            onMatchesEnabledChange={setMatchesEnabled}
                            showTagPickers={false}
                            previewEnabled={onAreaStep}
                            stylesSlot={(
                                <button
                                    type="button"
                                    onClick={() => jumpTo('styles', 'area')}
                                    className="flex w-full items-center gap-2 border border-line bg-surface px-3 py-1.5 text-left hover:bg-canvas"
                                >
                                    <IconStyles className="h-4 w-4 shrink-0 text-muted" />
                                    <div className="min-w-0 flex-1">
                                        {selectedProfileTags.length > 0 ? (
                                            <TagChips tags={selectedProfileTags} />
                                        ) : (
                                            <span className="text-xs text-muted">No styles yet — tap to choose</span>
                                        )}
                                    </div>
                                    <span className="shrink-0 text-xs font-medium text-action">Edit</span>
                                </button>
                            )}
                            areaNameControl={(
                                <div className="flex shrink-0 items-center gap-1.5">
                                    <label htmlFor="onboarding-area-name" className="text-[10px] font-medium uppercase tracking-wide text-ink-soft">
                                        Name
                                    </label>
                                    <input
                                        id="onboarding-area-name"
                                        ref={areaNameRef}
                                        type="text"
                                        value={areaLabelDraft}
                                        onChange={(e) => setAreaLabelDraft(e.target.value)}
                                        maxLength={120}
                                        placeholder="Area name"
                                        size={10}
                                        className="w-24 border border-line bg-surface px-1.5 py-1 text-[11px] text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                                    />
                                </div>
                            )}
                        />
                    )}

                    {/* STEP: follow */}
                    {step === 'follow' && (
                        <>
                            <div className="relative">
                                <input
                                    type="search"
                                    value={userSearch}
                                    onChange={(e) => {
                                        setUserSearch(e.target.value);
                                        setUserSearching(e.target.value.trim().length >= 2);
                                    }}
                                    placeholder="Search by name or @handle"
                                    aria-label="Search users"
                                    className="w-full border border-line bg-surface px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                                />
                                {userSearch.trim().length >= 2 && (
                                    <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-auto border border-line bg-surface shadow-lg">
                                        {userSearching && <p className="px-3 py-2 text-xs text-ink-soft">Searching…</p>}
                                        {!userSearching && userResults.length === 0 && (
                                            <p className="px-3 py-2 text-xs text-ink-soft">No matches.</p>
                                        )}
                                        {userResults.map((u) => {
                                            const handle = u.handle ?? '';
                                            const status = followStatus[handle] ?? (u.is_followed_by_viewer ? 'followed' : 'idle');
                                            const isDone = status === 'followed' || status === 'requested' || !!u.is_followed_by_viewer;
                                            const isBusy = status === 'following';
                                            return (
                                                <div
                                                    key={handle || u.display_name}
                                                    className="flex items-center gap-2 px-3 py-2 hover:bg-canvas"
                                                >
                                                    <Avatar url={u.avatar_url} size={7} />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1">
                                                            <span className="truncate text-sm font-medium text-ink">
                                                                {u.display_name || `@${handle}`}
                                                            </span>
                                                            {u.is_verified_organizer && (
                                                                <img src="/orga.png" alt="" title="Verified organizer" className="h-3.5 w-3.5 object-contain" />
                                                            )}
                                                        </div>
                                                        <div className="truncate text-[11px] text-ink-soft">
                                                            @{handle} · {u.subscribers_count} subscriber{u.subscribers_count === 1 ? '' : 's'}
                                                        </div>
                                                    </div>
                                                    {isDone ? (
                                                        <span className="shrink-0 border border-line bg-canvas px-2 py-1 text-xs font-medium text-ink-soft">
                                                            {status === 'requested' ? 'Requested' : 'Following'}
                                                        </span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            disabled={!handle || isBusy}
                                                            onClick={() => void followFromSearch(u)}
                                                            className="shrink-0 border border-action bg-action px-2.5 py-1 text-xs font-medium text-white hover:bg-action disabled:cursor-not-allowed disabled:opacity-50"
                                                        >
                                                            {isBusy ? 'Following…' : 'Follow'}
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                            {followItems === null ? (
                                <p className="text-sm text-muted">Loading suggestions…</p>
                            ) : followItems.length === 0 ? (
                                <p className="text-sm text-ink-soft">No suggestions yet — search above to find people.</p>
                            ) : (
                                <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto border border-line bg-surface">
                                    {followItems.map((u) => {
                                        const handle = u.handle ?? '';
                                        const status = followStatus[handle] ?? (u.is_followed_by_viewer ? 'followed' : 'idle');
                                        const isDone = status === 'followed' || status === 'requested';
                                        const isBusy = status === 'following' || status === 'unfollowing';
                                        return (
                                            <li key={handle || u.display_name}>
                                                <div className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-canvas">
                                                    <Avatar url={u.avatar_url} size={7} />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1">
                                                            <span className="truncate text-sm font-medium text-ink">
                                                                {u.display_name || handle}
                                                            </span>
                                                            {u.is_verified_organizer && (
                                                                <img src="/orga.png" alt="" title="Verified organizer" className="h-3.5 w-3.5 object-contain" />
                                                            )}
                                                        </div>
                                                        <div className="truncate text-[11px] text-ink-soft">@{handle}</div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleFollowToggle(u)}
                                                        disabled={!handle || isBusy}
                                                        title={isDone ? 'Click to undo' : undefined}
                                                        className={
                                                            'border px-2.5 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ' +
                                                            (isDone
                                                                ? 'border-action bg-action text-white'
                                                                : 'border-line bg-surface text-ink hover:bg-canvas')
                                                        }
                                                    >
                                                        {isBusy
                                                            ? status === 'unfollowing' ? 'Undoing…' : 'Following…'
                                                            : status === 'requested' ? 'Requested' : status === 'followed' ? 'Following' : 'Follow'}
                                                    </button>
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </>
                    )}

                    {/* STEP: local */}
                    {step === 'local' && (
                        <>
                            <p className="border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                                Optional — a separate “near home” profile with its own tighter radius.
                            </p>
                            <section>
                                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-soft">
                                    Dance styles
                                </label>
                                {tagsLoading ? (
                                    <p className="text-sm text-muted">Loading tags…</p>
                                ) : !danceGroup ? (
                                    <p className="text-sm text-ink-soft">No dance-style tags are available yet.</p>
                                ) : (
                                    <TagsPicker
                                        tagGroups={[danceGroup]}
                                        value={localDanceValue}
                                        onChange={setLocalDanceValue}
                                        allowFreeText={false}
                                        searchable
                                        hideGroupLabels
                                        wrap={false}
                                    />
                                )}
                            </section>
                            <section>
                                <label htmlFor="onboarding-local-city" className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-soft">
                                    City
                                </label>
                                {popularCities.length > 0 && (
                                    <div className="mb-2 flex flex-nowrap gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
                                        {popularCities.map((c) => (
                                            <button
                                                key={`${c.city}-${c.country ?? ''}`}
                                                type="button"
                                                onClick={() => pickCity(c)}
                                                className={
                                                    'shrink-0 whitespace-nowrap border px-2 py-1 text-xs transition ' +
                                                    (cityLabel === c.city
                                                        ? 'border-action bg-action text-white'
                                                        : 'border-line bg-surface text-ink hover:bg-canvas')
                                                }
                                            >
                                                {c.city}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="flex items-center gap-2">
                                    <div className="relative flex-1">
                                        <input
                                            id="onboarding-local-city"
                                            type="text"
                                            value={citySearch}
                                            onChange={(e) => setCitySearch(e.target.value)}
                                            onFocus={() => { if (citySuggestions.length > 0) setCitySuggestOpen(true); }}
                                            onBlur={() => window.setTimeout(() => setCitySuggestOpen(false), 150)}
                                            placeholder="Search a city (e.g. Berlin, Lisbon)"
                                            className="w-full border border-line px-2 py-1.5 text-xs focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                                        />
                                        {citySuggestOpen && citySuggestions.length > 0 && (
                                            <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-auto border border-line bg-surface shadow-sm">
                                                {citySuggestions.map((s) => (
                                                    <li key={`${s.latitude},${s.longitude}`}>
                                                        <button
                                                            type="button"
                                                            onMouseDown={(e) => e.preventDefault()}
                                                            onClick={() => {
                                                                setPin({ lat: s.latitude, lng: s.longitude });
                                                                setCityLabel(s.display_name);
                                                                setCitySearch(s.display_name);
                                                                setCitySuggestOpen(false);
                                                            }}
                                                            className="block w-full truncate px-2 py-1.5 text-left text-xs text-ink hover:bg-canvas"
                                                        >
                                                            {s.display_name}
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                        {citySearching && (
                                            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted">…</span>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={handleUseCurrentLocation}
                                        disabled={geoLoading}
                                        className="shrink-0 whitespace-nowrap border border-line bg-surface px-2 py-1.5 text-xs text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {geoLoading ? 'Locating…' : 'Use my location'}
                                    </button>
                                </div>
                            </section>
                            {/* Map, radius and alert only appear once a location is chosen. */}
                            {pin ? (
                                <>
                                    <div className="flex items-center justify-between gap-2 text-xs">
                                        <span className="truncate font-medium text-ink">{cityLabel.trim() || 'Selected location'}</span>
                                        <button
                                            type="button"
                                            onClick={clearLocalLocation}
                                            className="shrink-0 font-medium text-ink-soft hover:text-ink"
                                        >
                                            Remove location
                                        </button>
                                    </div>
                                    <section>
                                        <div className="mb-1 flex items-center justify-between gap-3">
                                            <label htmlFor="onboarding-local-radius" className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">
                                                Radius
                                            </label>
                                            <span className="text-xs font-medium text-ink">{radiusKm} km</span>
                                        </div>
                                        <input
                                            id="onboarding-local-radius"
                                            type="range"
                                            min={RADIUS_MIN_KM}
                                            max={RADIUS_MAX_KM}
                                            step={1}
                                            value={radiusKm}
                                            onChange={(e) => setRadiusKm(Number(e.target.value))}
                                            className="w-full"
                                        />
                                    </section>
                                    <section>
                                        <div className="h-40 w-full overflow-hidden border border-line">
                                            <MapContainer
                                                center={[pin.lat, pin.lng]}
                                                zoom={10}
                                                scrollWheelZoom={false}
                                                style={{ height: '100%', width: '100%' }}
                                            >
                                                <TileLayer
                                                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                                                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                                />
                                                <MapRecenter pin={pin} radiusKm={radiusKm} />
                                                <CircleMarker
                                                    center={[pin.lat, pin.lng]}
                                                    radius={6}
                                                    pathOptions={{ color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.9 }}
                                                />
                                                {localBboxBounds && (
                                                    <Rectangle
                                                        bounds={localBboxBounds}
                                                        pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.08 }}
                                                    />
                                                )}
                                            </MapContainer>
                                        </div>
                                    </section>
                                    <section className="border border-line bg-canvas p-3">
                                        <label className="flex items-start gap-2 text-sm text-ink">
                                            <input
                                                type="checkbox"
                                                checked={localMatchesEnabled}
                                                onChange={(e) => setLocalMatchesEnabled(e.target.checked)}
                                                className="mt-0.5 h-4 w-4"
                                            />
                                            <span>
                                                <span className="block font-medium">Alert me about near-home matches</span>
                                                <span className="mt-0.5 block text-xs text-ink-soft">
                                                    Get an email when a new event matches this local profile.
                                                </span>
                                            </span>
                                        </label>
                                    </section>
                                </>
                            ) : (
                                <p className="text-xs text-ink-soft">
                                    Pick a city or use your location to see the coverage box.
                                </p>
                            )}
                        </>
                    )}

                    {/* STEP: recap */}
                    {step === 'recap' && (
                        <div className="space-y-3">
                            <RecapSection title="Default search profile" onEdit={() => jumpTo('styles')}>
                                <RecapItem icon={<IconStyles className="h-4 w-4 text-muted" />}>
                                    <TagChips tags={selectedProfileTags} />
                                </RecapItem>
                                <div className="flex items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <AreaMiniMap area={prefs.area ?? DEFAULT_AREA_BBOX} />
                                        <span className="mt-1 flex items-center gap-1 text-[11px] text-ink-soft">
                                            <IconPin className="h-3 w-3 shrink-0 text-muted" />
                                            <span className="truncate">{prefs.area?.label ?? DEFAULT_AREA_BBOX.label}</span>
                                        </span>
                                    </div>
                                    <span className="flex shrink-0 items-center gap-1 text-xs text-ink">
                                        <IconBell className="h-3 w-3 text-muted" />
                                        {matchesEnabled ? 'Alerts on' : 'Alerts off'}
                                    </span>
                                </div>
                            </RecapSection>

                            <RecapSection title="Local search profile" onEdit={() => jumpTo('local')}>
                                <RecapItem icon={<IconPin className="h-4 w-4 text-muted" />}>
                                    <span className="truncate text-xs text-ink">
                                        {localCreated
                                            ? `${cityLabel.trim() || 'Local'} · ${radiusKm} km${localMatchesEnabled ? ' · alerts on' : ''}`
                                            : 'Skipped'}
                                    </span>
                                </RecapItem>
                            </RecapSection>

                            <RecapSection title="Following" onEdit={() => jumpTo('follow')}>
                                {followedUsers.length > 0 ? (
                                    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto scrollbar-hide">
                                        {followedUsers.map((u) => (
                                            <div key={u.handle ?? u.display_name} className="flex shrink-0 flex-col items-center gap-0.5" title={u.display_name || `@${u.handle ?? ''}`}>
                                                <Avatar url={u.avatar_url} size={10} />
                                                <span className="max-w-[64px] truncate text-[10px] text-ink-soft">
                                                    {u.display_name || `@${u.handle ?? ''}`}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <span className="text-sm text-ink-soft">None yet</span>
                                )}
                            </RecapSection>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="mt-4 flex items-center gap-2">
                    {step === 'local' && !returnTo ? (
                        <>
                            {/* Skip is the primary action: the local profile is optional, so
                                the low-friction path forward is the prominent one. */}
                            <button
                                type="button"
                                onClick={handleSkip}
                                disabled={advancing}
                                className="border border-line bg-surface px-4 py-2 text-sm text-ink-soft hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"

                            >
                                Skip for now
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleContinue()}
                                disabled={!canContinue}
                                className="flex-1 bg-action px-4 py-2 text-sm font-medium text-white hover:bg-action disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {advancing ? 'Saving…' : 'Save this profile'}
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={() => void handleContinue()}
                                disabled={!canContinue}
                                className="flex-1 bg-action px-4 py-2 text-sm font-medium text-white hover:bg-action disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {advancing ? 'Saving…' : step === 'recap' ? 'Start exploring' : returnTo ? 'Done' : 'Continue'}
                            </button>
                            {showSkip && !returnTo && (
                                <button
                                    type="button"
                                    onClick={handleSkip}
                                    disabled={advancing}
                                    className="border border-line bg-surface px-4 py-2 text-sm text-ink-soft hover:bg-canvas disabled:opacity-50"
                                >
                                    Skip
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Merge the step-1 dance selection back into the persisted browse tags so
 * Explorer/Calendar respect the same taste, preserving non-dance tags. */
function mergeDanceIntoPrefs(current: number[], danceGroup: TagGroup | null, danceIds: number[]): number[] {
    const nonDance = current.filter((id) => !(danceGroup?.tags.some((t) => t.id === id) ?? false));
    return [...nonDance, ...danceIds];
}

function Avatar({ url, size }: { url?: string | null; size: 7 | 10 }) {
    // Full literal classes so Tailwind's JIT scanner emits them.
    const box = size === 7 ? 'h-7 w-7' : 'h-10 w-10';
    if (url) {
        // eslint-disable-next-line no-restricted-syntax -- Avatars are allowed to be circular.
        return <img src={url} alt="" className={`${box} rounded-full object-cover`} />;
    }
    // eslint-disable-next-line no-restricted-syntax -- Avatar placeholders are allowed to be circular.
    return <div className={`${box} rounded-full bg-slate-200`} />;
}

/** Non-interactive mini map showing the saved area's bounding box (no pins),
 * used in the recap so the default profile reads as a place at a glance. */
function AreaMiniMap({ area }: { area: PreferredAreaPayload }) {
    const bounds: LatLngBoundsExpression = [
        [area.min_lat, area.min_lng],
        [area.max_lat, area.max_lng],
    ];
    return (
        <div className="h-20 w-full overflow-hidden border border-line">
            <MapContainer
                bounds={bounds}
                boundsOptions={{ padding: [8, 8] }}
                style={{ height: '100%', width: '100%' }}
                dragging={false}
                scrollWheelZoom={false}
                doubleClickZoom={false}
                zoomControl={false}
                attributionControl={false}
                keyboard={false}
            >
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <Rectangle bounds={bounds} pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.1 }} />
            </MapContainer>
        </div>
    );
}

/** Horizontally-scrollable row of tag chips; never wraps so the recap stays compact. */
function TagChips({ tags }: { tags: Tag[] }) {
    if (tags.length === 0) return <span className="text-sm text-ink-soft">—</span>;
    return (
        <div className="flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">
            {tags.map((t) => (
                <span
                    key={t.id}
                    className="shrink-0 whitespace-nowrap border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-ink"
                >
                    {t.label}
                </span>
            ))}
        </div>
    );
}

function RecapSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
    return (
        <div className="border border-line bg-surface px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between gap-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">{title}</div>
                <button
                    type="button"
                    onClick={onEdit}
                    className="shrink-0 text-xs font-medium text-action hover:text-action"
                >
                    Edit
                </button>
            </div>
            <div className="space-y-1.5">{children}</div>
        </div>
    );
}

function RecapItem({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">{icon}</span>
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

function IconStyles({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
    );
}

function IconPin({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 21s-6-5.686-6-10a6 6 0 1 1 12 0c0 4.314-6 10-6 10z" />
            <circle cx="12" cy="11" r="2" />
        </svg>
    );
}

function IconBell({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
    );
}
