import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Bookmark, Eye, PencilLine, Users } from 'lucide-react';
import { fetchMyHosting, type HostingResponse } from '../api';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import CancelEventSheet from '../components/CancelEventSheet';
import OrganizerClaimSheet from '../components/OrganizerClaimSheet';
import useSubmissionsChanged from '../hooks/useSubmissionsChanged';
import { MySubmissionsSection } from './MySubmissionsPage';
import type { CalendarEvent } from '../types';

type Tab = 'upcoming' | 'past' | 'added';

const TAB_LABELS: Record<Tab, string> = { upcoming: 'Upcoming', past: 'Past', added: 'Added by me' };
const isTab = (value: string | null): value is Tab => value === 'upcoming' || value === 'past' || value === 'added';

function formatWhen(iso: string) {
    return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Organizer hub: the events you host, their reach, and edit/cancel requests. */
export default function HostingPage() {
    const { user } = useAuth();
    const { organizerClaimsEnabled } = useFeatureFlags();
    const navigate = useNavigate();
    const location = useLocation();
    const [data, setData] = useState<HostingResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const tabParam = searchParams.get('tab');
    const tab: Tab = isTab(tabParam) ? tabParam : 'upcoming';
    const setTab = (t: Tab) => setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', t);
        return next;
    }, { replace: true });
    const [claimOpen, setClaimOpen] = useState(false);
    const [cancelTarget, setCancelTarget] = useState<CalendarEvent | null>(null);
    const [now] = useState(() => Date.now());

    const load = useCallback(() => {
        if (!user || !organizerClaimsEnabled) return;
        fetchMyHosting()
            .then((res) => { setData(res); setError(null); })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load your events'));
    }, [user, organizerClaimsEnabled]);

    useEffect(load, [load]);
    useSubmissionsChanged(load);

    if (!user) {
        return (
            <div className="mx-auto max-w-3xl px-4 py-6 text-sm text-ink-soft">
                <Link to="/login?next=/hosting" className="font-semibold text-action hover:underline">Sign in</Link> to manage the events you host.
            </div>
        );
    }
    if (!organizerClaimsEnabled) {
        return <div className="mx-auto max-w-3xl px-4 py-6 text-sm text-ink-soft">Hosting isn&apos;t available yet.</div>;
    }

    const items = data?.items ?? [];
    const pending = new Set(data?.pending_change_event_ids ?? []);
    const upcoming = items.filter((e) => new Date(e.end).getTime() >= now).sort((a, b) => a.start.localeCompare(b.start));
    const past = items.filter((e) => new Date(e.end).getTime() < now);
    const shown = tab === 'past' ? past : upcoming;
    const counts: Partial<Record<Tab, number>> = { upcoming: upcoming.length, past: past.length };

    return (
        <div className="mx-auto max-w-3xl px-4 py-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold text-ink">Hosting</h1>
                    <p className="mt-1 text-sm text-ink-soft">Events you organize. Changes are reviewed before they go live.</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    <Link
                        to="/suggest"
                        state={{ backgroundLocation: location }}
                        className="inline-flex items-center rounded-field bg-action px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
                    >
                        Add event
                    </Link>
                    <button
                        type="button"
                        onClick={() => setClaimOpen(true)}
                        className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                        Claim events
                    </button>
                </div>
            </div>

            {error && (
                <div role="alert" className="mt-4 rounded-card border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
                    {error}
                    <button type="button" onClick={load} className="ml-2 font-semibold underline">Try again</button>
                </div>
            )}

            <div role="tablist" aria-label="Hosting events" className="mt-4 flex gap-2 overflow-x-auto">
                {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
                    <button
                        key={t}
                        type="button"
                        role="tab"
                        aria-selected={tab === t}
                        onClick={() => setTab(t)}
                        className={`min-h-10 shrink-0 rounded-field border px-4 text-sm font-semibold ${tab === t ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft hover:border-action hover:text-action'}`}
                    >
                        {TAB_LABELS[t]} {data && counts[t] !== undefined ? `(${counts[t]})` : ''}
                    </button>
                ))}
            </div>

            {tab === 'added' ? (
                <MySubmissionsSection />
            ) : data === null && !error ? (
                <p className="py-8 text-sm text-muted">Loading…</p>
            ) : shown.length === 0 ? (
                <div className="py-8 text-sm text-ink-soft">
                    <p>{tab === 'upcoming' ? 'No upcoming events yet.' : 'No past events.'}</p>
                    {items.length === 0 && (
                        <button
                            type="button"
                            onClick={() => setClaimOpen(true)}
                            className="mt-3 inline-flex min-h-11 items-center rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90"
                        >
                            Claim an event you organize
                        </button>
                    )}
                </div>
            ) : (
                <ul className="mt-4 space-y-3">
                    {shown.map((event) => (
                        <li key={event.event_id} className="rounded-card border border-card-line bg-surface p-4">
                            <div className="flex flex-wrap items-center gap-2">
                                {event.is_cancelled && (
                                    <span className="bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">Cancelled</span>
                                )}
                                {pending.has(event.event_id) && (
                                    <span className="bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">Change in review</span>
                                )}
                            </div>
                            <Link to={`/event/${event.event_id}`} className="mt-1 block text-base font-semibold text-ink hover:underline">
                                {event.title}
                            </Link>
                            <p className="mt-0.5 text-sm text-ink-soft">
                                {formatWhen(event.start)}{event.city ? ` · ${event.city}` : ''}
                            </p>
                            <dl className="mt-3 flex gap-4 text-sm text-ink-soft">
                                <div className="flex items-center gap-1.5">
                                    <Users className="h-4 w-4" aria-hidden />
                                    <dt className="sr-only">Going</dt>
                                    <dd>{event.going_count ?? 0} going</dd>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <Bookmark className="h-4 w-4" aria-hidden />
                                    <dt className="sr-only">Saved</dt>
                                    <dd>{event.saved_count ?? 0} saved</dd>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <Eye className="h-4 w-4" aria-hidden />
                                    <dt className="sr-only">Views</dt>
                                    <dd>{event.view_count} views</dd>
                                </div>
                            </dl>
                            {tab === 'upcoming' && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => navigate(`/event/${event.event_id}/suggest-change`, { state: { backgroundLocation: location } })}
                                        className="inline-flex min-h-10 items-center gap-1.5 rounded-field border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-canvas"
                                    >
                                        <PencilLine className="h-4 w-4" aria-hidden />
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setCancelTarget(event)}
                                        className={`min-h-10 rounded-field px-3 text-sm font-semibold hover:bg-canvas ${event.is_cancelled ? 'text-action' : 'text-danger'}`}
                                    >
                                        {event.is_cancelled ? 'Restore' : 'Cancel event'}
                                    </button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {claimOpen && <OrganizerClaimSheet onClose={() => setClaimOpen(false)} />}
            {cancelTarget && (
                <CancelEventSheet
                    eventId={cancelTarget.event_id}
                    eventTitle={cancelTarget.title}
                    cancelled={cancelTarget.is_cancelled}
                    onClose={() => setCancelTarget(null)}
                    onSent={load}
                />
            )}
        </div>
    );
}
