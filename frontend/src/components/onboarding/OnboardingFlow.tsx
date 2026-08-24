import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Circle, CircleMarker, MapContainer, TileLayer, useMap } from 'react-leaflet';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
    completeOnboarding,
    createInterestProfile,
    deleteInterestProfile,
    fetchInterestProfiles,
    fetchPopularCities,
    fetchTagGroups,
    searchSuggestionAddress,
    updateInterestProfile,
    type GeocodeSuggestion,
    type HomeLocationPayload,
    type InterestProfile,
    type PopularCity,
    type PreferredAreaPayload,
} from '../../api';
import { AREA_PRESETS, DEFAULT_AREA_BBOX } from '../../constants/area';
import { useAuth } from '../../context/AuthContext';
import { usePreferences } from '../../context/PreferencesContext';
import type { Tag, TagGroup } from '../../types';
import OnboardingAreaEditor from './OnboardingAreaEditor';
import { bboxFromPinRadius } from './onboardingGeometry';

type Step = 'dances' | 'international' | 'home' | 'review';
type InternationalView = 'presets' | 'editor';
type HomeView = 'choice' | 'editor';

const STEPS: Step[] = ['dances', 'international', 'home', 'review'];
const RADIUS_VALUES = [5, 10, 25, 50, 100] as const;
const PRIMARY_DANCE_SLUGS = ['salsa', 'bachata', 'kizomba', 'zouk', 'mambo-on2', 'cha-cha', 'semba', 'rueda', 'son'];
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
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const next = searchParams.get('next') || '/';
    const { prefs, setPrefs } = usePreferences();
    const { refreshUser } = useAuth();
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
    const initialPrefsRef = useRef(prefs);

    const danceGroup = useMemo(() => tagGroups.find((group) => group.slug === 'dance-style' && group.enabled !== false) ?? null, [tagGroups]);
    const reachGroup = useMemo(() => tagGroups.find((group) => group.slug === 'reach' && group.enabled !== false) ?? null, [tagGroups]);
    const activeProfile = profiles.find((profile) => profile.is_active) ?? profiles[0] ?? null;
    const localReachId = reachGroup?.tags.find((tag) => tag.slug === 'local')?.id;
    const internationalReachId = reachGroup?.tags.find((tag) => tag.slug === 'international')?.id;

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
        setSaving(true);
        setError(null);
        try {
            await setPrefs({ area, tagIds: danceIds, homeLocation: home?.location ?? null });
            const internationalPayload = {
                label: activeProfile?.label ?? 'International area',
                area_label: area.label,
                min_lat: area.min_lat,
                min_lng: area.min_lng,
                max_lat: area.max_lat,
                max_lng: area.max_lng,
                dance_tag_ids: danceIds,
                reach_tag_ids: internationalReachId == null ? [] : [internationalReachId],
                matches_enabled: internationalAlerts,
                is_active: true,
            };
            if (activeProfile) await updateInterestProfile(activeProfile.id, internationalPayload);
            else await createInterestProfile(internationalPayload);

            const existingHomeProfile = profiles.find((profile) => isNearHomeProfile(profile));
            if (home) {
                const homeArea = bboxFromPinRadius(home.location, home.radiusKm, home.location.label);
                const homePayload = {
                    label: 'Near home', area_label: home.location.label,
                    min_lat: homeArea.min_lat, min_lng: homeArea.min_lng, max_lat: homeArea.max_lat, max_lng: homeArea.max_lng,
                    dance_tag_ids: danceIds,
                    reach_tag_ids: localReachId == null ? [] : [localReachId],
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

    const stepIndex = STEPS.indexOf(step);
    const header = {
        dances: ['What do you dance?', 'Select all that apply'],
        international: ['Where do you want to discover events?', 'Choose your international area.'],
        home: ['Find events near home?', 'Add a local search for events in your city and nearby area.'],
        review: ["You're all set", 'Review your preferences before exploring.'],
    }[step];

    if (step === 'international' && internationalView === 'editor') {
        return (
            <OnboardingShell stepIndex={1} compactHeader>
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
        <OnboardingShell stepIndex={stepIndex}>
            <div className="relative flex min-h-0 flex-1 flex-col">
                <header className="px-4 pt-5 text-center">
                    {step !== 'dances' && (
                        <button
                            type="button"
                            aria-label="Back"
                            onClick={() => {
                                if (step === 'home' && homeView === 'editor') setHomeView('choice');
                                else if (editingFromReview) goToStep('review');
                                else setStep(STEPS[Math.max(0, stepIndex - 1)]);
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
                    {step === 'home' && homeView === 'choice' && <HomeChoice onYes={() => setHomeView('editor')} onNo={() => { setHome(null); finishEditOrAdvance('review'); }} />}
                    {step === 'home' && homeView === 'editor' && <HomeEditor value={home} onChange={setHome} />}
                    {step === 'review' && <ReviewStep dances={danceGroup?.tags.filter((tag) => danceIds.includes(tag.id)) ?? []} area={area} home={home} onEdit={(target) => goToStep(target, true)} />}
                </main>
                {(step === 'dances' || (step === 'home' && homeView === 'editor') || step === 'review') && (
                    <StickyFooter>
                        <button
                            type="button"
                            disabled={saving || (step === 'dances' && danceIds.length === 0) || (step === 'home' && homeView === 'editor' && !home)}
                            onClick={() => {
                                if (step === 'dances') finishEditOrAdvance('international');
                                else if (step === 'home') finishEditOrAdvance('review');
                                else void saveAll();
                            }}
                            className="min-h-12 w-full bg-action px-4 text-sm font-semibold text-white hover:bg-action-strong disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {saving ? 'Saving…' : step === 'review' ? 'Start exploring' : editingFromReview ? 'Save' : 'Continue'}
                        </button>
                    </StickyFooter>
                )}
            </div>
        </OnboardingShell>
    );
}

function OnboardingShell({ stepIndex, compactHeader = false, children }: { stepIndex: number; compactHeader?: boolean; children: ReactNode }) {
    return (
        <div className="mx-auto flex h-full min-h-[560px] w-full max-w-lg flex-col overflow-hidden bg-surface sm:my-4 sm:h-[min(820px,calc(100%-32px))] sm:rounded-card sm:border sm:border-card-line sm:shadow-sm">
            <div className={compactHeader ? 'px-4 pt-3' : 'px-4 pt-4'}>
                <div className="mb-2 flex items-center justify-between text-xs font-bold text-action"><span>{stepIndex + 1}/4</span><span>{['Dance styles', 'International area', 'Near home', 'Review'][stepIndex]}</span></div>
                <div role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={stepIndex + 1} className="flex gap-2">
                    {[0, 1, 2, 3].map((index) => <span key={index} className={`h-1 flex-1 ${index <= stepIndex ? 'bg-action' : 'bg-line'}`} />)}
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
    const primary = PRIMARY_DANCE_SLUGS.map((slug) => group.tags.find((tag) => tag.slug === slug)).filter((tag): tag is Tag => Boolean(tag));
    const ordered = [...primary, ...group.tags.filter((tag) => !primary.some((item) => item.id === tag.id))];
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
    const [query, setQuery] = useState(value?.location.label ?? '');
    const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
    const [popularCities, setPopularCities] = useState<PopularCity[]>([]);
    const [locating, setLocating] = useState(false);
    useEffect(() => { void fetchPopularCities(5).then(setPopularCities).catch(() => undefined); }, []);
    useEffect(() => {
        if (query.trim().length < 3 || query === value?.location.label) return;
        const timer = window.setTimeout(() => { void searchSuggestionAddress(query.trim()).then(setSuggestions).catch(() => setSuggestions([])); }, 300);
        return () => window.clearTimeout(timer);
    }, [query, value?.location.label]);
    const chooseLocation = (location: HomeLocationPayload) => { setQuery(location.label); setSuggestions([]); onChange({ location, radiusKm: value?.radiusKm ?? 25, alertsEnabled: value?.alertsEnabled ?? true }); };
    const useCurrentLocation = () => {
        if (!navigator.geolocation) return;
        setLocating(true);
        navigator.geolocation.getCurrentPosition((position) => { chooseLocation({ lat: position.coords.latitude, lng: position.coords.longitude, label: 'Current location' }); setLocating(false); }, () => setLocating(false));
    };
    return (
        <div className="space-y-5">
            <section><label htmlFor="onboarding-city" className="mb-2 block text-sm font-semibold text-ink">City</label><div className="relative"><input id="onboarding-city" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setSuggestions([]); }} placeholder="Search a city" className="min-h-11 w-full border border-line bg-surface px-3 pr-20 text-sm text-ink focus:border-action focus:outline-none" /><button type="button" onClick={useCurrentLocation} disabled={locating} className="absolute right-2 top-0 min-h-11 text-xs font-semibold text-action disabled:opacity-50">{locating ? 'Locating…' : 'Locate'}</button>{suggestions.length > 0 && query !== value?.location.label && <ul className="absolute z-[800] mt-1 max-h-52 w-full overflow-y-auto border border-line bg-surface shadow-lg">{suggestions.map((suggestion) => <li key={`${suggestion.latitude}-${suggestion.longitude}`}><button type="button" onClick={() => chooseLocation({ lat: suggestion.latitude, lng: suggestion.longitude, label: suggestion.display_name })} className="min-h-11 w-full px-3 text-left text-sm text-ink hover:bg-canvas">{suggestion.display_name}</button></li>)}</ul>}</div>
                {!value && popularCities.length > 0 && <div className="mt-3 flex gap-2 overflow-x-auto pb-1 scrollbar-hide">{popularCities.map((city) => <button key={`${city.city}-${city.country ?? ''}`} type="button" onClick={() => chooseLocation({ lat: city.lat, lng: city.lng, label: [city.city, city.country].filter(Boolean).join(', ') })} className="min-h-11 shrink-0 border border-line bg-surface px-3 text-xs font-semibold text-ink">{city.city}</button>)}</div>}</section>
            {value && <><HomeMap value={value} /><section><div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold text-ink">Radius</span><span className="text-sm font-semibold text-action">{value.radiusKm} km</span></div><div className="grid grid-cols-5 gap-1">{RADIUS_VALUES.map((radius) => <button key={radius} type="button" onClick={() => onChange({ ...value, radiusKm: radius })} className={radius === value.radiusKm ? 'min-h-11 bg-action text-xs font-semibold text-white' : 'min-h-11 border border-line bg-surface text-xs font-semibold text-ink'}>{radius}{radius === 100 ? ' km' : ''}</button>)}</div></section><label className="flex min-h-12 items-center justify-between border-t border-line py-3 text-sm font-semibold text-ink"><span>New event alerts</span><input type="checkbox" checked={value.alertsEnabled} onChange={(event) => onChange({ ...value, alertsEnabled: event.target.checked })} className="h-5 w-5 accent-action" /></label></>}
        </div>
    );
}

function HomeMap({ value }: { value: HomeDraft }) {
    return <div className="relative h-44 overflow-hidden border border-line"><MapContainer center={[value.location.lat, value.location.lng]} zoom={10} scrollWheelZoom={false} zoomControl={false} style={{ height: '100%', width: '100%' }}><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /><HomeMapRecenter value={value} /><Circle center={[value.location.lat, value.location.lng]} radius={value.radiusKm * 1000} pathOptions={{ color: '#2563eb', weight: 2, fillColor: '#2563eb', fillOpacity: 0.14 }} /><CircleMarker center={[value.location.lat, value.location.lng]} radius={6} pathOptions={{ color: '#2563eb', fillColor: '#2563eb', fillOpacity: 1 }} /></MapContainer><span className="pointer-events-none absolute left-1/2 top-1/2 z-[500] -translate-x-1/2 translate-y-3 bg-surface/90 px-2 py-1 text-xs font-semibold text-ink">{value.location.label.split(',')[0]}</span></div>;
}

function HomeMapRecenter({ value }: { value: HomeDraft }) {
    const map = useMap();
    useEffect(() => { const bounds = bboxFromPinRadius(value.location, value.radiusKm, value.location.label); map.fitBounds([[bounds.min_lat, bounds.min_lng], [bounds.max_lat, bounds.max_lng]], { padding: [16, 16], animate: false }); }, [map, value]);
    return null;
}

function ReviewStep({ dances, area, home, onEdit }: { dances: Tag[]; area: PreferredAreaPayload; home: HomeDraft | null; onEdit: (step: Step) => void }) {
    return <div className="space-y-3"><ReviewCard icon="♪" title="Dance styles" value={dances.map((tag) => tag.label).join(', ')} onClick={() => onEdit('dances')} /><ReviewCard icon="◎" title="International area" value={area.label} onClick={() => onEdit('international')} /><ReviewCard icon="⌂" title="Near home" value={home ? `${home.location.label} · ${home.radiusKm} km` : 'Not set'} onClick={() => onEdit('home')} /></div>;
}

function ReviewCard({ icon, title, value, onClick }: { icon: string; title: string; value: string; onClick: () => void }) {
    return <button type="button" onClick={onClick} className="flex min-h-20 w-full items-center gap-3 rounded-card border border-card-line bg-surface p-4 text-left hover:bg-canvas"><span className="text-xl text-action" aria-hidden="true">{icon}</span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-ink">{title}</span><span className="mt-1 block truncate text-sm text-ink-soft">{value}</span></span><span aria-hidden="true" className="text-xl text-ink-soft">›</span></button>;
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
