import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Search, X } from 'lucide-react';
import {
    claimEvents,
    fetchMyOrganizerClaims,
    fetchPublicProfile,
    searchEvents,
    submitOrganizerClaim,
    updateMyBio,
    updateMySocialLinks,
    type EventSearchResult,
    type PublicProfile,
} from '../api';
import { useAuth } from '../context/AuthContext';
import type { OrganizerClaim } from '../types';
import BottomSheet from './BottomSheet';

export interface ClaimableEvent {
    event_id: string;
    title: string;
    start?: string | null;
}

interface Props {
    /** Prefilled when opened from an event's "I organize this event" action. */
    initialEvent?: ClaimableEvent;
    onClose: () => void;
    onSubmitted?: () => void;
}

const MAX_EVENTS = 20;
const INPUT = 'w-full rounded-field border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted focus:border-action focus:outline-none';
const PRIMARY = 'flex min-h-12 w-full items-center justify-center rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';

function formatDate(iso?: string | null) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * One sheet for every organizer request: completes the profile requirements
 * in place, picks events (prefilled from the event it was opened on) and
 * sends or extends the pending request.
 */
export default function OrganizerClaimSheet({ initialEvent, onClose, onSubmitted }: Props) {
    const { user, loading: authLoading } = useAuth();
    const handle = user?.handle ?? null;
    const [profile, setProfile] = useState<PublicProfile | null>(null);
    const [claims, setClaims] = useState<OrganizerClaim[] | null>(null);
    const [picked, setPicked] = useState<ClaimableEvent[]>(initialEvent ? [initialEvent] : []);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [done, setDone] = useState(false);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            handle ? fetchPublicProfile(handle).catch(() => null) : Promise.resolve(null),
            fetchMyOrganizerClaims().catch(() => []),
        ]).then(([p, c]) => {
            if (cancelled) return;
            setProfile(p);
            setClaims(c);
        });
        return () => { cancelled = true; };
    }, [handle]);

    const verified = Boolean(profile?.is_verified_organizer);
    const pending = useMemo(
        () => claims?.find((c) => c.status === 'pending' && c.kind === (verified ? 'events' : 'badge')) ?? null,
        [claims, verified],
    );
    const requestedIds = useMemo(() => new Set(pending?.events.map((e) => e.event_id) ?? []), [pending]);
    const newPicks = picked.filter((e) => !requestedIds.has(e.event_id));
    const hasBio = Boolean(profile?.bio?.trim());
    const hasSocial = Boolean(profile?.instagram_url?.trim() || profile?.facebook_url?.trim());
    const profileReady = hasBio && hasSocial;
    const loading = claims === null || authLoading;

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            if (newPicks.length) {
                await claimEvents(newPicks.map((e) => e.event_id));
            } else {
                await submitOrganizerClaim({ kind: 'badge' });
            }
            setDone(true);
            onSubmitted?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not send your request');
        } finally {
            setSubmitting(false);
        }
    };

    const count = newPicks.length;
    const noun = count === 1 ? 'event' : 'events';
    const canSubmit = !submitting && ((verified || pending) ? count > 0 : profileReady);
    const cta = verified
        ? (count ? `Send ${count} ${noun} for review` : 'Pick events to claim')
        : pending
            ? (count ? `Add ${count} ${noun} to my request` : 'Pick events to add')
            : 'Send request';

    if (done) {
        return (
            <BottomSheet title="Request sent" titleSize="large" onClose={onClose} footer={
                <button type="button" onClick={onClose} className={PRIMARY}>Done</button>
            }>
                <div className="flex flex-col items-center gap-3 py-4 text-center">
                    {/* eslint-disable-next-line no-restricted-syntax -- success badge is a circle by design */}
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-success">
                        <Check className="h-7 w-7" aria-hidden />
                    </span>
                    <p className="text-sm text-ink-soft">
                        Our team reviews organizer requests, usually within two days. You&apos;ll get a notification with the decision.
                    </p>
                    <Link to="/account#organizer" onClick={onClose} className="text-sm font-semibold text-action hover:underline">
                        Track your request in Settings
                    </Link>
                </div>
            </BottomSheet>
        );
    }

    return (
        <BottomSheet
            title={verified ? 'Claim events you organize' : 'Become a verified organizer'}
            subtitle={verified ? 'Organized events show your name and you can propose updates.' : 'Get the verified badge and manage the events you organize.'}
            titleSize="large"
            onClose={onClose}
            footer={
                <div className="space-y-2">
                    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                    <button type="button" onClick={submit} disabled={!canSubmit || loading} className={PRIMARY}>
                        {submitting ? 'Sending…' : cta}
                    </button>
                </div>
            }
        >
            {loading ? (
                <p className="py-6 text-center text-sm text-muted">Loading…</p>
            ) : (
                <div className="space-y-6 pb-2">
                    {pending && (
                        <p className="rounded-field border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-ink">
                            Your request is waiting for review. Events you add join the same request.
                        </p>
                    )}
                    {!verified && (
                        <ProfileChecklist
                            handle={handle}
                            profile={profile}
                            hasBio={hasBio}
                            hasSocial={hasSocial}
                            onSaved={setProfile}
                        />
                    )}
                    <EventPicker
                        picked={picked}
                        requested={pending?.events ?? []}
                        onPick={(e) => setPicked((prev) => (prev.some((p) => p.event_id === e.event_id) ? prev : [...prev, e]))}
                        onRemove={(id) => setPicked((prev) => prev.filter((p) => p.event_id !== id))}
                        optional={!verified && !pending}
                        full={requestedIds.size + newPicks.length >= MAX_EVENTS}
                    />
                    <section>
                        <h3 className="text-sm font-semibold text-ink">What happens next</h3>
                        <ul className="mt-2 space-y-1.5 text-sm text-ink-soft">
                            <li>• Our team checks your profile and links, usually within two days.</li>
                            <li>• Approved events show “Organized by” with your name.</li>
                            <li>• Changes you propose to your events are reviewed before they go live.</li>
                        </ul>
                    </section>
                </div>
            )}
        </BottomSheet>
    );
}

function CheckRow({ done, label, children }: { done: boolean; label: string; children?: React.ReactNode }) {
    return (
        <li className="py-3">
            <div className="flex items-center gap-3">
                {/* eslint-disable-next-line no-restricted-syntax -- status dot is a circle by design */}
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${done ? 'border-success bg-success text-white' : 'border-line text-transparent'}`}>
                    <Check className="h-4 w-4" aria-hidden />
                </span>
                <span className={`text-sm ${done ? 'text-ink' : 'font-medium text-ink'}`}>{label}</span>
                <span className="sr-only">{done ? 'done' : 'to do'}</span>
            </div>
            {children && <div className="mt-2 pl-9">{children}</div>}
        </li>
    );
}

function ProfileChecklist({
    handle,
    profile,
    hasBio,
    hasSocial,
    onSaved,
}: {
    handle: string | null;
    profile: PublicProfile | null;
    hasBio: boolean;
    hasSocial: boolean;
    onSaved: (p: PublicProfile) => void;
}) {
    const [bio, setBio] = useState('');
    const [instagram, setInstagram] = useState('');
    const [facebook, setFacebook] = useState('');
    const [saving, setSaving] = useState<'bio' | 'social' | null>(null);
    const [error, setError] = useState<string | null>(null);

    if (!handle || !profile) {
        return (
            <section>
                <h3 className="text-sm font-semibold text-ink">Your public profile</h3>
                <p className="mt-1 text-sm text-ink-soft">
                    Choose a handle in <Link to="/account" className="font-semibold text-action hover:underline">Settings</Link> so we can review your profile.
                </p>
            </section>
        );
    }

    const save = async (kind: 'bio' | 'social') => {
        setSaving(kind);
        setError(null);
        try {
            if (kind === 'bio') {
                onSaved(await updateMyBio(bio.trim()));
            } else {
                const ig = instagram.replace(/^@/, '').trim();
                const fb = facebook.replace(/^@/, '').trim();
                onSaved(await updateMySocialLinks({
                    ...(ig ? { instagram_url: `https://instagram.com/${ig}` } : {}),
                    ...(fb ? { facebook_url: `https://facebook.com/${fb}` } : {}),
                }));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save');
        } finally {
            setSaving(null);
        }
    };

    return (
        <section>
            <h3 className="text-sm font-semibold text-ink">Your public profile</h3>
            <p className="mt-1 text-sm text-ink-soft">Admins use these to confirm you organize events.</p>
            <ul className="mt-1 divide-y divide-card-line">
                <CheckRow done={hasBio} label={hasBio ? 'Bio added' : 'Add a short bio'}>
                    {!hasBio && (
                        <div className="space-y-2">
                            <label className="sr-only" htmlFor="claim-bio">Bio</label>
                            <textarea
                                id="claim-bio"
                                rows={3}
                                maxLength={280}
                                value={bio}
                                onChange={(e) => setBio(e.target.value)}
                                placeholder="e.g. I run Salsa Fridays at Studio A since 2019"
                                className={INPUT}
                            />
                            <button
                                type="button"
                                onClick={() => save('bio')}
                                disabled={!bio.trim() || saving !== null}
                                className="min-h-10 rounded-field border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                            >
                                {saving === 'bio' ? 'Saving…' : 'Save bio'}
                            </button>
                        </div>
                    )}
                </CheckRow>
                <CheckRow done={hasSocial} label={hasSocial ? 'Social link added' : 'Add Instagram or Facebook'}>
                    {!hasSocial && (
                        <div className="space-y-2">
                            <label className="flex items-center gap-2">
                                <span className="w-20 shrink-0 text-sm text-ink-soft">Instagram</span>
                                <input value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="@handle" autoCapitalize="none" className={INPUT} />
                            </label>
                            <label className="flex items-center gap-2">
                                <span className="w-20 shrink-0 text-sm text-ink-soft">Facebook</span>
                                <input value={facebook} onChange={(e) => setFacebook(e.target.value)} placeholder="page name" autoCapitalize="none" className={INPUT} />
                            </label>
                            <button
                                type="button"
                                onClick={() => save('social')}
                                disabled={!(instagram.trim() || facebook.trim()) || saving !== null}
                                className="min-h-10 rounded-field border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                            >
                                {saving === 'social' ? 'Saving…' : 'Save link'}
                            </button>
                        </div>
                    )}
                </CheckRow>
            </ul>
            {error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}
        </section>
    );
}

function EventPicker({
    picked,
    requested,
    onPick,
    onRemove,
    optional,
    full,
}: {
    picked: ClaimableEvent[];
    requested: { event_id: string; event_title: string | null; event_start: string | null }[];
    onPick: (e: ClaimableEvent) => void;
    onRemove: (id: string) => void;
    optional: boolean;
    full: boolean;
}) {
    const [q, setQ] = useState('');
    const [results, setResults] = useState<EventSearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const timer = useRef<number | null>(null);
    const requestedIds = new Set(requested.map((r) => r.event_id));
    const pickedIds = new Set(picked.map((p) => p.event_id));
    const newPicks = picked.filter((p) => !requestedIds.has(p.event_id));

    useEffect(() => {
        const term = q.trim();
        if (timer.current) window.clearTimeout(timer.current);
        if (term.length < 2) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced typeahead lifecycle
            setResults([]);
            setSearching(false);
            return;
        }
        setSearching(true);
        timer.current = window.setTimeout(() => {
            searchEvents(term, { limit: 8, dateScope: 'upcoming' })
                .then(setResults)
                .catch(() => setResults([]))
                .finally(() => setSearching(false));
        }, 250);
        return () => { if (timer.current) window.clearTimeout(timer.current); };
    }, [q]);

    return (
        <section>
            <h3 className="text-sm font-semibold text-ink">
                Events you organize {optional && <span className="font-normal text-muted">(optional)</span>}
            </h3>
            {(requested.length > 0 || newPicks.length > 0) && (
                <ul className="mt-2 flex flex-wrap gap-2">
                    {requested.map((r) => (
                        <li key={r.event_id} className="flex min-h-9 items-center gap-1.5 rounded-field border border-line bg-canvas px-3 text-sm text-ink-soft">
                            <span className="max-w-[14rem] truncate">{r.event_title ?? r.event_id}</span>
                            <span className="text-xs text-muted">· in review</span>
                        </li>
                    ))}
                    {newPicks.map((p) => (
                        <li key={p.event_id} className="flex min-h-9 items-center gap-1 rounded-field border border-action bg-blue-50 pl-3 text-sm text-ink">
                            <span className="max-w-[14rem] truncate">{p.title}</span>
                            <button type="button" onClick={() => onRemove(p.event_id)} aria-label={`Remove ${p.title}`} className="flex h-9 w-9 items-center justify-center text-ink-soft hover:text-ink">
                                <X className="h-4 w-4" aria-hidden />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="relative mt-3">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
                <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    disabled={full}
                    placeholder={full ? `Up to ${MAX_EVENTS} events per request` : 'Search events by name or city'}
                    aria-label="Search events you organize"
                    className={`${INPUT} pl-9`}
                />
            </div>
            {searching && <p className="mt-2 text-sm text-muted">Searching…</p>}
            {results.length > 0 && (
                <ul className="mt-2 divide-y divide-card-line overflow-hidden rounded-field border border-line">
                    {results.map((r) => {
                        const taken = Boolean(r.has_organizer);
                        const added = pickedIds.has(r.event_id) || requestedIds.has(r.event_id);
                        return (
                            <li key={r.event_id}>
                                <button
                                    type="button"
                                    disabled={taken || added}
                                    onClick={() => { onPick({ event_id: r.event_id, title: r.title, start: r.start }); setQ(''); }}
                                    className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                                        <span className="block truncate text-xs text-ink-soft">
                                            {[formatDate(r.start), r.city].filter(Boolean).join(' · ')}
                                        </span>
                                    </span>
                                    <span className="shrink-0 text-xs text-muted">
                                        {taken ? 'Has an organizer' : added ? 'Added' : 'Add'}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
