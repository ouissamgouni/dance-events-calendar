import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fetchTagGroups, type PreferredAreaPayload, type ReachFilter } from '../api';
import CityRadiusEditor from '../components/CityRadiusEditor';
import OnboardingAreaEditor from '../components/onboarding/OnboardingAreaEditor';
import { cityRadiusArea, type CityRadiusValue } from '../components/onboarding/onboardingGeometry';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import { useInterestProfiles } from '../hooks/useInterestProfiles';
import type { Tag, TagGroup } from '../types';
import { REACH_FILTER_ICON_SRC, REACH_FILTER_LABELS } from '../utils/reach';

type GeoMode = 'area' | 'radius';

interface EditorRouteState {
    returnTo?: string;
    initialSearch?: {
        area: PreferredAreaPayload | null;
        areaLabel: string;
        danceIds: number[];
        reachFilter?: ReachFilter;
        reachIds: number[];
    };
}

export default function SearchProfileEditorPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const routeState = location.state as EditorRouteState | null;
    const returnTo = routeState?.returnTo ?? '/mine/profiles';
    const { profileId } = useParams();
    const editingId = profileId ? Number(profileId) : null;
    const { profiles, createProfile, updateProfile } = useInterestProfiles();
    const [groups, setGroups] = useState<TagGroup[]>([]);
    const [initialized, setInitialized] = useState(false);
    const [name, setName] = useState('My events');
    const [danceIds, setDanceIds] = useState<number[]>([]);
    const [reach, setReach] = useState<ReachFilter>('any');
    const [mode, setMode] = useState<GeoMode | null>(null);
    const [area, setArea] = useState<PreferredAreaPayload>({ ...DEFAULT_AREA_BBOX });
    const [cityRadius, setCityRadius] = useState<CityRadiusValue | null>(null);
    const [alerts, setAlerts] = useState(true);
    const [editingArea, setEditingArea] = useState(false);
    const [editingRadius, setEditingRadius] = useState(false);
    const [reachInfo, setReachInfo] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { void fetchTagGroups().then(setGroups).catch(() => setGroups([])); }, []);
    const danceGroup = useMemo(() => groups.find((group) => group.slug === 'dance-style') ?? null, [groups]);
    const reachGroup = useMemo(() => groups.find((group) => group.slug === 'reach') ?? null, [groups]);
    const profile = editingId == null ? null : profiles?.find((item) => item.id === editingId) ?? null;

    useEffect(() => {
        if (initialized || !reachGroup || (editingId != null && profiles === null)) return;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            if (profile) {
                setName(profile.label);
                setDanceIds(profile.dance_tag_ids);
                setReach(profile.reach_filter);
                setAlerts(profile.matches_enabled);
                setArea({ label: profile.area_label, min_lat: profile.min_lat, min_lng: profile.min_lng, max_lat: profile.max_lat, max_lng: profile.max_lng });
                setMode(profile.geo_kind);
                if (profile.geo_kind === 'radius' && profile.center_lat != null && profile.center_lng != null && profile.radius_km != null) {
                    setCityRadius({ location: { lat: profile.center_lat, lng: profile.center_lng, label: profile.area_label.split(' · ')[0] }, radiusKm: profile.radius_km });
                }
            } else if (editingId == null && routeState?.initialSearch) {
                const initial = routeState.initialSearch;
                setDanceIds(initial.danceIds);
                setReach(initial.reachFilter ?? (initial.reachIds.some((id) => reachGroup.tags.some((tag) => tag.id === id && tag.slug === 'regional')) ? 'regional_plus' : initial.reachIds.length > 0 ? 'international' : 'any'));
                if (initial.area) {
                    setArea({ ...initial.area, label: initial.areaLabel });
                    setMode('area');
                }
            }
            setInitialized(true);
        });
        return () => { cancelled = true; };
    }, [editingId, initialized, profile, profiles, reachGroup, routeState]);

    const dances = danceGroup?.tags ?? [];
    const toggleDance = (tag: Tag) => setDanceIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id]);
    const openGeo = () => {
        if (mode === 'area') setEditingArea(true);
        else if (mode === 'radius') setEditingRadius(true);
    };

    const save = async () => {
        if (!name.trim()) { setError('Enter a profile name.'); return; }
        if (danceIds.length === 0) { setError('Choose at least one dance style.'); return; }
        if (!mode || (mode === 'radius' && !cityRadius)) { setError('Choose a search area.'); return; }
        setSaving(true);
        setError(null);
        const geoArea = mode === 'radius' && cityRadius ? cityRadiusArea(cityRadius) : area;
        const payload = {
            label: name.trim(), area_label: geoArea.label, geo_kind: mode,
            min_lat: geoArea.min_lat, min_lng: geoArea.min_lng, max_lat: geoArea.max_lat, max_lng: geoArea.max_lng,
            center_lat: mode === 'radius' ? cityRadius!.location.lat : null,
            center_lng: mode === 'radius' ? cityRadius!.location.lng : null,
            radius_km: mode === 'radius' ? cityRadius!.radiusKm : null,
            dance_tag_ids: danceIds, reach_filter: reach, matches_enabled: alerts,
        } as const;
        try {
            if (editingId == null) await createProfile(payload);
            else await updateProfile(editingId, payload);
            navigate(returnTo);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Failed to save profile');
        } finally { setSaving(false); }
    };

    if (!initialized) return <p className="p-4 text-sm text-muted">Loading…</p>;
    if (editingArea) return <div className="mx-auto flex h-full max-w-lg flex-col bg-surface"><OnboardingAreaEditor area={area} alertsEnabled={alerts} onAreaChange={setArea} onAlertsChange={setAlerts} onBack={() => setEditingArea(false)} onContinue={() => { setMode('area'); setEditingArea(false); }} continueLabel="Use this area" title="Define area" showAlerts={false} /></div>;
    if (editingRadius) return <div className="mx-auto flex min-h-full max-w-lg flex-col bg-surface"><header className="relative flex min-h-12 items-center justify-center px-14"><button type="button" onClick={() => setEditingRadius(false)} className="absolute left-2 min-h-11 min-w-11 text-2xl">‹</button><h1 className="text-base font-bold text-ink">Around a city</h1></header><main className="flex-1 px-4 py-4"><CityRadiusEditor value={cityRadius} onChange={setCityRadius} /></main><footer className="sticky bottom-0 border-t border-line bg-surface p-4"><button type="button" disabled={!cityRadius} onClick={() => { setMode('radius'); setEditingRadius(false); }} className="min-h-12 w-full bg-action text-sm font-semibold text-white disabled:opacity-40">Use this area</button></footer></div>;

    return <div className="mx-auto flex min-h-full max-w-lg flex-col bg-surface"><header className="relative flex min-h-14 items-center justify-center border-b border-line px-14"><button type="button" onClick={() => navigate(returnTo)} className="absolute left-3 text-sm font-semibold text-action">Cancel</button><h1 className="text-sm font-bold text-ink">{editingId == null ? 'Create profile' : 'Edit profile'}</h1></header><main className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <section><h2 className="mb-2 text-xs font-semibold uppercase text-ink-soft">Dance styles</h2><div className="grid grid-cols-3 gap-2">{dances.map((tag) => <button key={tag.id} type="button" aria-pressed={danceIds.includes(tag.id)} onClick={() => toggleDance(tag)} className={danceIds.includes(tag.id) ? 'min-h-10 border border-action bg-blue-50 px-2 text-xs font-semibold text-action' : 'min-h-10 border border-line px-2 text-xs font-semibold text-ink'}>{tag.label}{danceIds.includes(tag.id) ? ' ✓' : ''}</button>)}</div></section>
        <section><div className="mb-2 flex items-center justify-between"><h2 className="text-xs font-semibold uppercase text-ink-soft">Event reach</h2><button type="button" aria-label="About event reach" onClick={() => setReachInfo(true)} className="h-8 w-8 text-action">ⓘ</button></div><div className="grid grid-cols-3 border border-line">{(['any', 'regional_plus', 'international'] as const).map((choice) => <button key={choice} type="button" aria-pressed={reach === choice} onClick={() => setReach(choice)} className={reach === choice ? 'flex min-h-14 flex-col items-center justify-center gap-1 bg-blue-50 px-2 text-xs font-semibold text-action' : 'flex min-h-14 flex-col items-center justify-center gap-1 px-2 text-xs font-semibold text-ink'}><img src={REACH_FILTER_ICON_SRC[choice]} alt="" aria-hidden="true" className="h-5 w-5 object-contain" />{REACH_FILTER_LABELS[choice]}</button>)}</div></section>
        <section><h2 className="mb-2 text-xs font-semibold uppercase text-ink-soft">Search area</h2>{mode ? <button type="button" onClick={openGeo} className="flex min-h-16 w-full items-center border border-line px-3 text-left"><span className="flex-1"><span className="block text-sm font-semibold text-ink">{mode === 'radius' && cityRadius ? cityRadiusArea(cityRadius).label : area.label}</span><span className="mt-1 block text-xs text-ink-soft">{mode === 'area' ? 'Area' : 'Around a city'}</span></span><span>›</span></button> : <button type="button" onClick={() => setMode('area')} className="flex min-h-12 w-full items-center justify-between border border-line px-3 text-sm font-semibold text-ink">Choose search area <span>›</span></button>}{mode === 'area' && <button type="button" onClick={() => setEditingArea(true)} className="mt-2 text-sm font-semibold text-action">Edit area</button>}{mode === 'radius' && <button type="button" onClick={() => setEditingRadius(true)} className="mt-2 text-sm font-semibold text-action">Edit city and radius</button>}{mode === null && <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" onClick={() => { setMode('area'); setEditingArea(true); }} className="min-h-12 border border-line text-sm font-semibold">Area</button><button type="button" onClick={() => { setMode('radius'); setEditingRadius(true); }} className="min-h-12 border border-line text-sm font-semibold">Around a city</button></div>}</section>
        <section><label htmlFor="profile-name" className="mb-2 block text-xs font-semibold uppercase text-ink-soft">Profile name</label><input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="min-h-11 w-full border border-line px-3 text-sm focus:border-action focus:outline-none" /></section>
        <label className="flex min-h-12 items-center justify-between border-t border-line py-3 text-sm font-semibold text-ink"><span>New event alerts</span><input type="checkbox" checked={alerts} onChange={(event) => setAlerts(event.target.checked)} className="h-5 w-5 accent-action" /></label>{error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </main><footer className="sticky bottom-0 border-t border-line bg-surface p-4"><button type="button" disabled={saving} onClick={() => void save()} className="min-h-12 w-full bg-action text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : editingId == null ? 'Create profile' : 'Save changes'}</button></footer>{reachInfo && <div className="fixed inset-0 z-[11000] flex items-end bg-slate-900/40" onClick={() => setReachInfo(false)}><div role="dialog" aria-modal="true" className="w-full rounded-t-card bg-surface p-5" onClick={(event) => event.stopPropagation()}><h2 className="text-lg font-bold text-ink">About event reach</h2><div className="mt-4 space-y-3 text-sm"><p><strong>Any</strong><br /><span className="text-ink-soft">All events, including events without a reach classification.</span></p><p><strong>Regional+</strong><br /><span className="text-ink-soft">Regional and international events.</span></p><p><strong>International</strong><br /><span className="text-ink-soft">International events only.</span></p></div><button type="button" onClick={() => setReachInfo(false)} className="mt-5 min-h-11 w-full bg-action font-semibold text-white">Done</button></div></div>}</div>;
}
