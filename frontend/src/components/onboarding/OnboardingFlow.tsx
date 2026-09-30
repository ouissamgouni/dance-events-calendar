import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
    completeOnboarding,
    createInterestProfile,
    deleteInterestProfile,
    fetchOnboardingSuggestions,
    fetchInterestProfiles,
    fetchTagGroups,
    followUser,
    searchUsers,
    unfollowUser,
    updateUserProfile,
    updateInterestProfile,
    type HomeLocationPayload,
    type InterestProfile,
    type PreferredAreaPayload,
    type UserSearchResult,
} from '../../api';
import CityRadiusEditor from '../CityRadiusEditor';
import AreaMapPreview from '../AreaMapPreview';
import { AREA_PRESETS, DEFAULT_AREA_BBOX } from '../../constants/area';
import { useAuth } from '../../context/AuthContext';
import { useFeatureFlagsReady, useOptionalFeatureFlags } from '../../context/FeatureFlagsContext';
import { usePreferences } from '../../context/PreferencesContext';
import type { Tag, TagGroup } from '../../types';
import AvatarEditor from '../AvatarEditor';
import OnboardingAreaEditor from './OnboardingAreaEditor';
import { bboxFromPinRadius } from './onboardingGeometry';
import { bboxSearchArea, radiusSearchArea } from '../../utils/searchArea';
import { generateProfileName } from '../../utils/searchProfiles';

type Step = 'dances' | 'international' | 'home' | 'follow' | 'profile' | 'review';
type InternationalView = 'presets' | 'editor';
type HomeView = 'choice' | 'editor';
type FollowStatus = 'idle' | 'following' | 'unfollowing' | 'followed' | 'requested';

const BASE_STEPS: Step[] = ['dances', 'international', 'home', 'follow', 'review'];
const PROFILE_STEPS: Step[] = ['dances', 'international', 'home', 'follow', 'profile', 'review'];
const SUGGESTION_LIMIT = 7;
const LATIN_AMERICA: PreferredAreaPayload = { label: 'Latin America', min_lat: -56, min_lng: -118, max_lat: 33, max_lng: -34 };
const CUSTOM_AREA: PreferredAreaPayload = { label: 'Custom', min_lat: -55, min_lng: -70, max_lat: 55, max_lng: 70 };
const ONBOARDING_PRESETS: PreferredAreaPayload[] = [
    ...['Europe', 'North America'].map((label) => AREA_PRESETS.find((preset) => preset.label === label)!),
    LATIN_AMERICA,
    ...['Asia', 'Africa', 'Oceania', 'Worldwide'].map((label) => AREA_PRESETS.find((preset) => preset.label === label)!),
    CUSTOM_AREA,
];

interface HomeDraft {
    location: HomeLocationPayload;
    radiusKm: number;
    alertsEnabled: boolean;
}

export default function OnboardingFlow() {
    const flags = useOptionalFeatureFlags();
    const flagsReady = useFeatureFlagsReady();
    const { user, loading: authLoading } = useAuth();

    if (!flagsReady || (flags.onboardingProfileStepEnabled && (authLoading || !user))) {
        return <div className="flex h-full items-center justify-center text-sm text-ink-soft">Loading…</div>;
    }

    return <OnboardingFlowContent profileStepEnabledAtMount={flags.onboardingProfileStepEnabled} />;
}

function OnboardingFlowContent({ profileStepEnabledAtMount }: { profileStepEnabledAtMount: boolean }) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const next = searchParams.get('next') || '/';
    const { prefs, setPrefs } = usePreferences();
    const { user, refreshUser } = useAuth();
    const [profileStepEnabled] = useState(profileStepEnabledAtMount);
    const steps = profileStepEnabled ? PROFILE_STEPS : BASE_STEPS;
    const [step, setStep] = useState<Step>('dances');
    const [internationalView, setInternationalView] = useState<InternationalView>('presets');
    const [homeView, setHomeView] = useState<HomeView>('choice');
    const [editingFromReview, setEditingFromReview] = useState(false);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [profiles, setProfiles] = useState<InterestProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [danceIds, setDanceIds] = useState<number[]>(prefs.tagIds);
    const [area, setArea] = useState<PreferredAreaPayload>(prefs.area ?? DEFAULT_AREA_BBOX);
    const [internationalAlerts, setInternationalAlerts] = useState(true);
    const [internationalNameManuallyEdited, setInternationalNameManuallyEdited] = useState(false);
    const [home, setHome] = useState<HomeDraft | null>(null);
    const [nameDraft, setNameDraft] = useState(user?.name ?? '');
    const [followItems, setFollowItems] = useState<UserSearchResult[] | null>(null);
    const [followStatus, setFollowStatus] = useState<Record<string, FollowStatus>>({});
    const [followSuggestionsLoading, setFollowSuggestionsLoading] = useState(false);
    const [followSuggestionsRequest, setFollowSuggestionsRequest] = useState(0);
    const [userSearch, setUserSearch] = useState('');
    const [userResults, setUserResults] = useState<UserSearchResult[]>([]);
    const [userSearching, setUserSearching] = useState(false);
    const initialPrefsRef = useRef(prefs);
    const followLoadedRequestRef = useRef(-1);

    const danceGroup = useMemo(() => tagGroups.find((group) => group.slug === 'dance-style' && group.enabled !== false) ?? null, [tagGroups]);
    const activeProfile = profiles.find((profile) => profile.is_active) ?? profiles[0] ?? null;

    useEffect(() => {
        let cancelled = false;
        Promise.all([fetchTagGroups({ scope: 'event', onboarding: true }), fetchInterestProfiles().catch(() => [])])
            .then(([groups, loadedProfiles]) => {
                if (cancelled) return;
                setTagGroups(groups);
                setProfiles(loadedProfiles);
                const loadedDanceGroup = groups.find((group) => group.slug === 'dance-style' && group.enabled !== false);
                const active = loadedProfiles.find((profile) => profile.is_active) ?? loadedProfiles[0];
                const homeProfile = loadedProfiles.find((profile) => isNearHomeProfile(profile));
                if (active) {
                    setDanceIds(active.dance_tag_ids);
                    setArea({ label: active.area_label, min_lat: active.min_lat, min_lng: active.min_lng, max_lat: active.max_lat, max_lng: active.max_lng });
                    setInternationalAlerts(active.matches_enabled);
                    setInternationalNameManuallyEdited(true);
                } else if (loadedDanceGroup) {
                    setDanceIds(loadedDanceGroup.tags.filter((tag) => initialPrefsRef.current.tagIds.includes(tag.id)).map((tag) => tag.id));
                }
                if (initialPrefsRef.current.homeLocation && homeProfile) {
                    setHome({ location: initialPrefsRef.current.homeLocation, radiusKm: 25, alertsEnabled: homeProfile.matches_enabled });
                }
            })
            .catch(() => { if (!cancelled) setError('We could not load your preferences. Please try again.'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (step !== 'follow' || followLoadedRequestRef.current === followSuggestionsRequest) return;
        followLoadedRequestRef.current = followSuggestionsRequest;
        let cancelled = false;
        setFollowSuggestionsLoading(true);
        fetchOnboardingSuggestions(SUGGESTION_LIMIT)
            .then((response) => {
                if (cancelled) return;
                setFollowItems(response.items);
                setFollowStatus((statuses) => {
                    const next = { ...statuses };
                    response.items.forEach((item) => {
                        next[item.handle] ??= item.is_followed_by_viewer ? 'followed' : 'idle';
                    });
                    return next;
                });
            })
            .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'We could not load follow suggestions.'); })
            .finally(() => { if (!cancelled) setFollowSuggestionsLoading(false); });
        return () => { cancelled = true; };
    }, [step, followSuggestionsRequest]);

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
                .then((response) => { if (!cancelled) setUserResults(response.items); })
                .catch(() => { if (!cancelled) setUserResults([]); })
                .finally(() => { if (!cancelled) setUserSearching(false); });
        }, 250);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [userSearch]);

    const addToFollowList = (candidate: UserSearchResult, prepend = false) => {
        setFollowItems((current) => {
            const items = current ?? [];
            if (items.some((item) => item.handle === candidate.handle)) return items;
            return prepend ? [candidate, ...items] : [...items, candidate];
        });
    };

    const toggleFollow = async (candidate: UserSearchResult) => {
        const handle = candidate.handle;
        const current = followStatus[handle] ?? (candidate.is_followed_by_viewer ? 'followed' : 'idle');
        if (current === 'following' || current === 'unfollowing') return;
        addToFollowList(candidate);
        setError(null);
        const isFollowing = current === 'followed' || current === 'requested';
        setFollowStatus((statuses) => ({ ...statuses, [handle]: isFollowing ? 'unfollowing' : 'following' }));
        try {
            const result = isFollowing ? await unfollowUser(handle) : await followUser(handle);
            const nextStatus: FollowStatus = result.is_following
                ? result.follow_status === 'pending' ? 'requested' : 'followed'
                : 'idle';
            setFollowStatus((statuses) => ({ ...statuses, [handle]: nextStatus }));
            setFollowItems((items) => (items ?? []).map((item) => item.handle === handle
                ? { ...item, is_followed_by_viewer: result.is_following, is_friend: result.is_friend, is_subscribed: result.is_subscribed }
                : item));
            window.dispatchEvent(new Event('network:changed'));
        } catch (caught) {
            setFollowStatus((statuses) => ({ ...statuses, [handle]: current }));
            setError(caught instanceof Error ? caught.message : 'Failed to update follow.');
        }
    };

    const followFromSearch = (candidate: UserSearchResult) => {
        addToFollowList(candidate, true);
        setUserSearch('');
        setUserResults([]);
        void toggleFollow(candidate);
    };

    const goToStep = (nextStep: Step, fromReview = false) => {
        setError(null);
        setEditingFromReview(fromReview);
        setStep(nextStep);
        if (nextStep === 'international') setInternationalView(fromReview ? 'editor' : 'presets');
        if (nextStep === 'home') setHomeView(fromReview && home ? 'editor' : 'choice');
    };

    const finishEditOrAdvance = (nextStep: Step) => {
        if (editingFromReview) {
            setEditingFromReview(false);
            setStep('review');
        } else {
            setStep(nextStep);
        }
    };

    const saveAll = async () => {
        if (danceIds.length === 0) return;
        const displayName = nameDraft.trim();
        if (profileStepEnabled && !displayName) return;
        setSaving(true);
        setError(null);
        try {
            if (profileStepEnabled && user && displayName !== user.name.trim()) {
                await updateUserProfile({ display_name: displayName });
            }
            await setPrefs({ area, tagIds: danceIds, homeLocation: home?.location ?? null });
            const internationalPayload = {
                label: generateProfileName({ danceIds, danceGroup, areaLabel: area.label, reachFilter: 'international' }),
                area_label: area.label,
                geo_kind: 'area' as const,
                min_lat: area.min_lat,
                min_lng: area.min_lng,
                max_lat: area.max_lat,
                max_lng: area.max_lng,
                dance_tag_ids: danceIds,
                reach_filter: 'international' as const,
                matches_enabled: internationalAlerts,
                is_active: true,
            };
            if (activeProfile) await updateInterestProfile(activeProfile.id, internationalPayload);
            else await createInterestProfile(internationalPayload);

            const existingHomeProfile = profiles.find((profile) => isNearHomeProfile(profile));
            if (home) {
                const homeArea = bboxFromPinRadius(home.location, home.radiusKm, home.location.label);
                const homePayload = {
                    label: 'Near home', area_label: `${home.location.label.split(',')[0]} · ${home.radiusKm} km`,
                    geo_kind: 'radius' as const,
                    min_lat: homeArea.min_lat, min_lng: homeArea.min_lng, max_lat: homeArea.max_lat, max_lng: homeArea.max_lng,
                    center_lat: home.location.lat, center_lng: home.location.lng, radius_km: home.radiusKm,
                    dance_tag_ids: danceIds,
                    reach_filter: 'any' as const,
                    matches_enabled: home.alertsEnabled,
                    is_active: false,
                };
                if (existingHomeProfile) await updateInterestProfile(existingHomeProfile.id, homePayload);
                else await createInterestProfile(homePayload);
            } else if (existingHomeProfile) {
                await deleteInterestProfile(existingHomeProfile.id);
            }
            await completeOnboarding([]);
            await refreshUser();
            navigate(next, { replace: true });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
        } finally {
            setSaving(false);
        }
    };

    const stepIndex = steps.indexOf(step);
    const header = {
        dances: ['What do you dance?', 'Select all that apply'],
        international: ['Where do you want to discover events?', 'Choose your international area.'],
        home: ['Find events near home?', 'Add a local search for events in your city and nearby area.'],
        follow: ['Build your tribe', 'Follow a few people to see their calendars and activity.'],
        profile: ['Complete your profile', 'Confirm the name people will see and optionally add a picture.'],
        review: ["You're all set", 'Review your preferences before exploring.'],
    }[step];

    if (step === 'international' && internationalView === 'editor') {
        return (
            <OnboardingShell stepIndex={1} profileStepEnabled={profileStepEnabled} compactHeader>
                <OnboardingAreaEditor
                    area={area}
                    alertsEnabled={internationalAlerts}
                    nameManuallyEdited={internationalNameManuallyEdited}
                    onAreaChange={setArea}
                    onAlertsChange={setInternationalAlerts}
                    onNameManuallyEdited={() => setInternationalNameManuallyEdited(true)}
                    onBack={() => editingFromReview ? goToStep('review') : setInternationalView('presets')}
                    onContinue={() => finishEditOrAdvance('home')}
                    continueLabel={editingFromReview ? 'Save' : 'Continue'}
                />
            </OnboardingShell>
        );
    }

    return (
        <OnboardingShell stepIndex={stepIndex} profileStepEnabled={profileStepEnabled}>
            <div className="relative flex min-h-0 flex-1 flex-col">
                <header className="px-4 pt-5 text-center">
                    {step !== 'dances' && (
                        <button
                            type="button"
                            aria-label="Back"
                            onClick={() => {
                                if (step === 'home' && homeView === 'editor') setHomeView('choice');
                                else if (editingFromReview) goToStep('review');
                                else setStep(steps[Math.max(0, stepIndex - 1)]);
                            }}
                            className="absolute left-4 top-3 min-h-11 min-w-11 text-left text-2xl text-ink"
                        >
                            ‹
                        </button>
                    )}
                    <h1 className="px-8 text-2xl font-bold text-ink">{step === 'home' && homeView === 'editor' ? 'Set your home location' : step === 'review' ? "You're all set!" : header[0]}</h1>
                    {!(step === 'home' && homeView === 'editor') && <p className="mt-2 text-sm text-ink-soft">{header[1]}</p>}
                </header>
                {error && <p role="alert" className="mx-4 mt-4 border border-line bg-canvas px-3 py-2 text-sm text-danger">{error}</p>}
                <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-6">
                    {step === 'dances' && <DanceStep loading={loading} group={danceGroup} selectedIds={danceIds} onChange={setDanceIds} />}
                    {step === 'international' && <PresetStep onSelect={(preset) => { setArea({ ...preset }); setInternationalNameManuallyEdited(false); setInternationalView('editor'); }} />}
                    {step === 'home' && homeView === 'choice' && <HomeChoice onYes={() => setHomeView('editor')} onNo={() => { setHome(null); finishEditOrAdvance('follow'); }} />}
                    {step === 'home' && homeView === 'editor' && <HomeEditor value={home} onChange={setHome} />}
                    {step === 'follow' && (
                        <FollowStep
                            items={followItems}
                            statuses={followStatus}
                            loadingSuggestions={followSuggestionsLoading}
                            search={userSearch}
                            searchResults={userResults}
                            searching={userSearching}
                            onSearchChange={(value) => { setUserSearch(value); setUserSearching(value.trim().length >= 2); }}
                            onShuffle={() => setFollowSuggestionsRequest((request) => request + 1)}
                            onToggle={(candidate) => void toggleFollow(candidate)}
                            onFollowSearchResult={followFromSearch}
                        />
                    )}
                    {step === 'profile' && (
                        <ProfileStep
                            loading={!user}
                            name={nameDraft}
                            avatarUrl={user?.avatar_url ?? null}
                            hasCustomAvatar={user?.has_custom_avatar ?? false}
                            onNameChange={setNameDraft}
                            onAvatarChange={refreshUser}
                        />
                    )}
                    {step === 'review' && <ReviewStep dances={danceGroup?.tags.filter((tag) => danceIds.includes(tag.id)) ?? []} area={area} home={home} followedUsers={(followItems ?? []).filter((item) => ['followed', 'requested'].includes(followStatus[item.handle] ?? 'idle'))} profile={profileStepEnabled ? { name: nameDraft.trim(), avatarUrl: user?.avatar_url ?? null } : null} onEdit={(target) => goToStep(target, true)} />}
                </main>
                {(step === 'dances' || (step === 'home' && homeView === 'editor') || step === 'follow' || step === 'profile' || step === 'review') && (
                    <StickyFooter>
                        <div className="flex gap-3">
                            {step === 'follow' && !editingFromReview && <button type="button" onClick={() => finishEditOrAdvance(profileStepEnabled ? 'profile' : 'review')} className="min-h-12 border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas">Skip</button>}
                            <button
                                type="button"
                                disabled={saving || (step === 'dances' && danceIds.length === 0) || (step === 'home' && homeView === 'editor' && !home) || (step === 'profile' && (!user || !nameDraft.trim()))}
                                onClick={() => {
                                    if (step === 'dances') finishEditOrAdvance('international');
                                    else if (step === 'home') finishEditOrAdvance('follow');
                                    else if (step === 'follow') finishEditOrAdvance(profileStepEnabled ? 'profile' : 'review');
                                    else if (step === 'profile') finishEditOrAdvance('review');
                                    else void saveAll();
                                }}
                                className="min-h-12 flex-1 bg-action px-4 text-sm font-semibold text-white hover:bg-action-strong disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                {saving ? 'Saving…' : step === 'review' ? 'Start exploring' : editingFromReview ? 'Save' : 'Continue'}
                            </button>
                        </div>
                    </StickyFooter>
                )}
            </div>
        </OnboardingShell>
    );
}

function OnboardingShell({ stepIndex, profileStepEnabled, compactHeader = false, children }: { stepIndex: number; profileStepEnabled: boolean; compactHeader?: boolean; children: ReactNode }) {
    const labels = profileStepEnabled ? ['Dance styles', 'International area', 'Near home', 'Build your tribe', 'Profile', 'Review'] : ['Dance styles', 'International area', 'Near home', 'Build your tribe', 'Review'];
    return (
        <div className="mx-auto flex h-full min-h-[560px] w-full max-w-lg flex-col overflow-hidden bg-surface sm:my-4 sm:h-[min(820px,calc(100%-32px))] sm:rounded-card sm:border sm:border-card-line sm:shadow-sm">
            <div className={compactHeader ? 'px-4 pt-3' : 'px-4 pt-4'}>
                <div className="mb-2 flex items-center justify-between text-xs font-bold text-action"><span>{stepIndex + 1}/{labels.length}</span><span>{labels[stepIndex]}</span></div>
                <div role="progressbar" aria-valuemin={1} aria-valuemax={labels.length} aria-valuenow={stepIndex + 1} className="flex gap-2">
                    {labels.map((label, index) => <span key={label} className={`h-1 flex-1 ${index <= stepIndex ? 'bg-action' : 'bg-line'}`} />)}
                </div>
            </div>
            {children}
        </div>
    );
}

function DanceStep({ loading, group, selectedIds, onChange }: { loading: boolean; group: TagGroup | null; selectedIds: number[]; onChange: (ids: number[]) => void }) {
    const [expanded, setExpanded] = useState(false);
    if (loading) return <p className="text-sm text-muted">Loading dance styles…</p>;
    if (!group) return <p className="text-sm text-ink-soft">No dance styles are available.</p>;
    const ordered = group.tags;
    const visible = expanded ? ordered : ordered.slice(0, 4);
    const hasMore = ordered.length > 4;
    return <div className="grid grid-cols-2 gap-3">{visible.map((tag) => <DanceButton key={tag.id} tag={tag} selected={selectedIds.includes(tag.id)} onToggle={() => onChange(toggleId(selectedIds, tag.id))} />)}{hasMore && !expanded && <button type="button" onClick={() => setExpanded(true)} className="min-h-12 border border-line bg-surface px-3 text-sm font-semibold text-action">+ More styles</button>}</div>;
}

function DanceButton({ tag, selected, onToggle }: { tag: Tag; selected: boolean; onToggle: () => void }) {
    return <button type="button" aria-pressed={selected} onClick={onToggle} className={selected ? 'min-h-12 border border-action bg-action px-3 text-sm font-semibold text-white' : 'min-h-12 border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-canvas'}>{selected ? `✓ ${tag.label}` : tag.label}</button>;
}

function PresetStep({ onSelect }: { onSelect: (area: PreferredAreaPayload) => void }) {
    return <div className="grid grid-cols-2 gap-3">{ONBOARDING_PRESETS.map((preset) => <button key={preset.label} type="button" onClick={() => onSelect(preset)} className="flex min-h-14 items-center gap-3 border border-line bg-surface px-3 text-left text-sm font-semibold text-ink hover:border-action hover:bg-canvas"><PresetIcon name={preset.label} /><span>{preset.label}</span></button>)}</div>;
}

function PresetIcon({ name }: { name: string }) {
    const paths: Record<string, ReactNode> = {
        Europe: <><path d="M5 16V8l4-3 2 3 4-1 4 4-3 7-6 1Z" /><path d="m8 11 3 2 2-2 3 2" /></>,
        'North America': <><path d="m4 7 5-3 7 2 4 5-5 2-2 7-4-4-3-5Z" /><path d="m15 13 3 4" /></>,
        'Latin America': <><path d="m8 4 7 2 3 5-4 3-1 6-3-3 1-5-5-3Z" /><path d="m13 20 2-2" /></>,
        Asia: <><path d="m3 9 4-5 5 2 3-2 6 5-4 3-2 7-5-3-4 2-2-5Z" /><path d="m9 10 4 2 3-2" /></>,
        Africa: <><path d="m8 4 8 1 4 6-5 8-4 1-2-6-4-3Z" /><path d="m10 9 5 3" /></>,
        Oceania: <><path d="m5 8 5-3 4 2 3-1 3 5-5 1-2 5-5 2-3-5Z" /><path d="M3 21h18" /></>,
        Worldwide: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>,
        Custom: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /><path d="M8 8h8v8H8z" /></>,
    };
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-6 w-6 shrink-0 text-action">{paths[name]}</svg>;
}

function HomeChoice({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
    return <div className="space-y-3"><button type="button" onClick={onYes} className="flex min-h-16 w-full items-center gap-3 border border-action bg-surface px-4 text-left text-action"><span className="text-2xl" aria-hidden="true">⌂</span><span className="flex-1 text-sm font-semibold">Yes, find events near home</span><span aria-hidden="true">›</span></button><button type="button" onClick={onNo} className="flex min-h-16 w-full items-center gap-3 border border-line bg-surface px-4 text-left text-ink"><span className="text-2xl text-ink-soft" aria-hidden="true">⌖</span><span className="flex-1 text-sm font-semibold">Not now</span><span aria-hidden="true">›</span></button><p className="pt-1 text-center text-xs text-ink-soft">Add it later in Settings</p></div>;
}

function HomeEditor({ value, onChange }: { value: HomeDraft | null; onChange: (value: HomeDraft | null) => void }) {
    return (
        <div className="space-y-4">
            <CityRadiusEditor
                value={value ? { location: value.location, radiusKm: value.radiusKm } : null}
                onChange={(next) => onChange({ ...next, alertsEnabled: value?.alertsEnabled ?? true })}
            />
            {value && <label className="flex min-h-12 items-center justify-between border-t border-line py-3 text-sm font-semibold text-ink"><span>New event alerts</span><input type="checkbox" checked={value.alertsEnabled} onChange={(event) => onChange({ ...value, alertsEnabled: event.target.checked })} className="h-5 w-5 accent-action" /></label>}
        </div>
    );
}

function FollowStep({ items, statuses, loadingSuggestions, search, searchResults, searching, onSearchChange, onShuffle, onToggle, onFollowSearchResult }: { items: UserSearchResult[] | null; statuses: Record<string, FollowStatus>; loadingSuggestions: boolean; search: string; searchResults: UserSearchResult[]; searching: boolean; onSearchChange: (value: string) => void; onShuffle: () => void; onToggle: (candidate: UserSearchResult) => void; onFollowSearchResult: (candidate: UserSearchResult) => void }) {
    return (
        <div className="space-y-4">
            <div className="relative">
                <input type="search" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search by name or @handle" aria-label="Search users" className="min-h-12 w-full rounded-field border border-line bg-surface px-3 text-sm text-ink focus:border-action focus:outline-none" />
                {search.trim().length >= 2 && (
                    <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-field border border-line bg-surface shadow-lg">
                        {searching && <p className="px-3 py-3 text-sm text-ink-soft">Searching…</p>}
                        {!searching && searchResults.length === 0 && <p className="px-3 py-3 text-sm text-ink-soft">No matches.</p>}
                        {searchResults.map((candidate) => <FollowRow key={candidate.handle} candidate={candidate} status={statuses[candidate.handle] ?? (candidate.is_followed_by_viewer ? 'followed' : 'idle')} onToggle={() => onFollowSearchResult(candidate)} compact />)}
                    </div>
                )}
            </div>
            <div>
                {(loadingSuggestions || (items && items.length > 0)) && (
                    <div className="flex items-center justify-between pb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Suggestions for you</span>
                        {items && items.length > 0 && <button type="button" onClick={onShuffle} disabled={loadingSuggestions} className="text-xs font-medium text-action hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50">Shuffle</button>}
                    </div>
                )}
                {items === null ? <p className="text-sm text-muted">Loading suggestions…</p> : items.length === 0 ? <p className="text-sm text-ink-soft">No suggestions yet. Search above to find people.</p> : <ul className="divide-y divide-card-line">{items.map((candidate) => <li key={candidate.handle}><FollowRow candidate={candidate} status={statuses[candidate.handle] ?? (candidate.is_followed_by_viewer ? 'followed' : 'idle')} onToggle={() => onToggle(candidate)} /></li>)}</ul>}
            </div>
        </div>
    );
}

function FollowRow({ candidate, status, onToggle, compact = false }: { candidate: UserSearchResult; status: FollowStatus; onToggle: () => void; compact?: boolean }) {
    const isFollowing = status === 'followed' || status === 'requested';
    const isBusy = status === 'following' || status === 'unfollowing';
    return (
        <div className={`flex items-center gap-3 ${compact ? 'px-3 py-2' : 'py-3'}`}>
            <FollowAvatar candidate={candidate} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5"><span className="truncate text-sm font-semibold text-ink">{candidate.display_name || `@${candidate.handle}`}</span>{candidate.is_verified_organizer && <img src="/orga.png" alt="" title="Verified organizer" className="h-4 w-4 object-contain" />}</div>
                <p className="truncate text-xs text-ink-soft">@{candidate.handle}{compact ? ` · ${candidate.subscribers_count} subscriber${candidate.subscribers_count === 1 ? '' : 's'}` : ''}</p>
            </div>
            <button type="button" disabled={isBusy} onClick={onToggle} title={isFollowing ? 'Click to undo' : undefined} className={isFollowing ? 'min-h-10 border border-action bg-action px-3 text-xs font-semibold text-white disabled:opacity-50' : 'min-h-10 border border-line bg-surface px-3 text-xs font-semibold text-ink hover:bg-canvas disabled:opacity-50'}>{isBusy ? status === 'unfollowing' ? 'Undoing…' : 'Following…' : status === 'requested' ? 'Requested' : status === 'followed' ? 'Following' : 'Follow'}</button>
        </div>
    );
}

function FollowAvatar({ candidate }: { candidate: UserSearchResult }) {
    // eslint-disable-next-line no-restricted-syntax -- Profile avatars are circular by design.
    return candidate.avatar_url ? <img src={candidate.avatar_url} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-canvas text-sm font-semibold text-ink-soft">{(candidate.display_name || candidate.handle).charAt(0).toUpperCase()}</span>;
}

function ProfileStep({ loading, name, avatarUrl, hasCustomAvatar, onNameChange, onAvatarChange }: { loading: boolean; name: string; avatarUrl: string | null; hasCustomAvatar: boolean; onNameChange: (name: string) => void; onAvatarChange: () => Promise<void> }) {
    if (loading) return <p className="text-sm text-ink-soft">Loading your profile…</p>;
    return (
        <div className="space-y-6">
            <AvatarEditor avatarUrl={avatarUrl} hasCustomAvatar={hasCustomAvatar} name={name} onChange={onAvatarChange} />
            <label className="block">
                <span className="mb-2 block text-sm font-semibold text-ink">Display name</span>
                <input type="text" value={name} onChange={(event) => onNameChange(event.target.value)} maxLength={120} autoComplete="name" className="min-h-12 w-full rounded-field border border-line bg-surface px-3 text-base text-ink focus:border-action focus:outline-none" />
                {!name.trim() && <span className="mt-2 block text-sm text-danger">Enter the name you want people to see.</span>}
            </label>
        </div>
    );
}

function ReviewStep({ dances, area, home, followedUsers, profile, onEdit }: { dances: Tag[]; area: PreferredAreaPayload; home: HomeDraft | null; followedUsers: UserSearchResult[]; profile: { name: string; avatarUrl: string | null } | null; onEdit: (step: Step) => void }) {
    // eslint-disable-next-line no-restricted-syntax -- Profile avatars are circular by design.
    return <div className="space-y-3"><ReviewCard icon="♪" title="Dance styles" value={dances.map((tag) => tag.label).join(', ')} onClick={() => onEdit('dances')} /><ReviewCard icon="◎" title="International area" value={area.label} preview={<AreaMapPreview area={bboxSearchArea(area, 'preference')} className="h-12 w-16" />} onClick={() => onEdit('international')} /><ReviewCard icon="⌂" title="Near home" value={home ? `${home.location.label} · ${home.radiusKm} km` : 'Not set'} preview={home ? <AreaMapPreview area={radiusSearchArea(home.location.label, home.location, home.radiusKm, 'preference')} className="h-12 w-16" /> : undefined} onClick={() => onEdit('home')} /><ReviewCard icon="♙" title="Following" value={followedUsers.length > 0 ? followedUsers.map((candidate) => candidate.display_name || `@${candidate.handle}`).join(', ') : 'None yet'} onClick={() => onEdit('follow')} />{profile && <ReviewCard icon="" title="Profile" value={profile.name} preview={profile.avatarUrl ? <img src={profile.avatarUrl} alt="" className="h-12 w-12 rounded-full object-cover" referrerPolicy="no-referrer" /> : <span className="flex h-12 w-12 items-center justify-center rounded-full bg-canvas font-semibold text-ink-soft">{profile.name.charAt(0).toUpperCase()}</span>} onClick={() => onEdit('profile')} />}</div>;
}

function ReviewCard({ icon, title, value, preview, onClick }: { icon: string; title: string; value: string; preview?: ReactNode; onClick: () => void }) {
    return <button type="button" onClick={onClick} className="flex min-h-20 w-full items-center gap-3 rounded-card border border-card-line bg-surface p-4 text-left hover:bg-canvas"><span className="text-xl text-action" aria-hidden="true">{icon}</span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-ink">{title}</span><span className="mt-1 block truncate text-sm text-ink-soft">{value}</span></span>{preview}<span aria-hidden="true" className="text-xl text-ink-soft">›</span></button>;
}

function StickyFooter({ children }: { children: ReactNode }) {
    return <div className="sticky bottom-0 z-[700] border-t border-line bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">{children}</div>;
}

function toggleId(ids: number[], id: number): number[] {
    return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

function isNearHomeProfile(profile: InterestProfile): boolean {
    return !profile.is_active && (profile.label === 'Near home' || profile.label === 'Local events');
}
