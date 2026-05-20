import { useEffect, useMemo, useRef, useState } from 'react';
import {
    cancelOrganizerClaim,
    fetchMyOrganizerClaims,
    fetchPublicProfile,
    searchEvents,
    submitOrganizerClaim,
    type EventSearchResult,
} from '../api';
import type { OrganizerClaim } from '../types';

interface Props {
    handle: string | null;
}

function statusBadge(status: string) {
    const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        approved: 'bg-emerald-100 text-emerald-700',
        rejected: 'bg-slate-200 text-slate-700',
    };
    return (
        <span
            className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${colors[status] ?? 'bg-gray-100 text-gray-600'
                }`}
        >
            {status}
        </span>
    );
}

function kindBadge(kind: 'badge' | 'events') {
    const label = kind === 'badge' ? 'Verified badge' : 'Events';
    const cls =
        kind === 'badge'
            ? 'bg-indigo-100 text-indigo-700'
            : 'bg-sky-100 text-sky-700';
    return (
        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${cls}`}>
            {label}
        </span>
    );
}

/**
 * Organizer claim panel.
 *
 * Two distinct flows backed by one section:
 *
 * 1. **Not verified** → submit a ``badge`` claim (no events). Requires
 *    bio + ≥1 social link. Approval flips ``is_verified_organizer``.
 * 2. **Already verified** → submit an ``events`` claim by freely
 *    searching the catalogue and picking events the user organizes.
 *    Approval attributes the events to the organizer AND auto-marks
 *    them as Going with public visibility.
 *
 * Claims history (both kinds) is always shown below the active form.
 */
export default function OrganizerClaimSection({ handle }: Props) {
    // Profile-derived gating.
    const [bio, setBio] = useState<string | null>(null);
    const [instagramUrl, setInstagramUrl] = useState<string | null>(null);
    const [facebookUrl, setFacebookUrl] = useState<string | null>(null);
    const [isVerifiedOrganizer, setIsVerifiedOrganizer] = useState(false);
    const [claims, setClaims] = useState<OrganizerClaim[]>([]);

    // Events-claim picker state.
    const [picked, setPicked] = useState<EventSearchResult[]>([]);
    const [searchQ, setSearchQ] = useState('');
    const [searchResults, setSearchResults] = useState<EventSearchResult[]>([]);
    const [searching, setSearching] = useState(false);

    // UI state.
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState(true);

    const hasBio = !!(bio && bio.trim());
    const hasSocial =
        !!(instagramUrl && instagramUrl.trim()) ||
        !!(facebookUrl && facebookUrl.trim());
    const prerequisitesMet = hasBio && hasSocial;

    const pendingBadgeClaim = useMemo(
        () => claims.find((c) => c.status === 'pending' && c.kind === 'badge'),
        [claims],
    );
    const pendingEventsClaim = useMemo(
        () => claims.find((c) => c.status === 'pending' && c.kind === 'events'),
        [claims],
    );

    const load = () => {
        setLoading(true);
        const profilePromise = handle
            ? fetchPublicProfile(handle).catch(() => null)
            : Promise.resolve(null);
        Promise.all([profilePromise, fetchMyOrganizerClaims().catch(() => [])])
            .then(([profile, cl]) => {
                if (profile) {
                    setBio(profile.bio);
                    setInstagramUrl(profile.instagram_url);
                    setFacebookUrl(profile.facebook_url);
                    setIsVerifiedOrganizer(profile.is_verified_organizer);
                }
                setClaims(cl);
            })
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handle]);

    // Debounced typeahead — only active for verified organizers.
    const searchTimerRef = useRef<number | null>(null);
    useEffect(() => {
        if (!isVerifiedOrganizer) return;
        const q = searchQ.trim();
        if (q.length < 2) {
            setSearchResults([]);
            setSearching(false);
            return;
        }
        if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
        setSearching(true);
        searchTimerRef.current = window.setTimeout(async () => {
            try {
                const rows = await searchEvents(q, 10);
                setSearchResults(rows);
            } catch {
                setSearchResults([]);
            } finally {
                setSearching(false);
            }
        }, 200);
        return () => {
            if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
        };
    }, [searchQ, isVerifiedOrganizer]);

    const pickEvent = (e: EventSearchResult) => {
        setPicked((prev) =>
            prev.find((p) => p.event_id === e.event_id) ? prev : [...prev, e],
        );
        setSearchQ('');
        setSearchResults([]);
    };

    const removePicked = (id: string) =>
        setPicked((prev) => prev.filter((p) => p.event_id !== id));

    const submitBadge = async () => {
        if (!prerequisitesMet) return;
        setSubmitting(true);
        setError(null);
        setMessage(null);
        try {
            await submitOrganizerClaim({ kind: 'badge' });
            setMessage(
                'Verified-organizer request submitted — an admin will review it shortly.',
            );
            load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Submission failed');
        } finally {
            setSubmitting(false);
        }
    };

    const submitEvents = async () => {
        if (picked.length === 0) return;
        setSubmitting(true);
        setError(null);
        setMessage(null);
        try {
            await submitOrganizerClaim({
                kind: 'events',
                event_ids: picked.map((p) => p.event_id),
            });
            setMessage(
                'Event claim submitted — once approved you will be marked as Going on these events.',
            );
            setPicked([]);
            load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Submission failed');
        } finally {
            setSubmitting(false);
        }
    };

    const cancel = async (id: string) => {
        try {
            await cancelOrganizerClaim(id);
            load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Cancel failed');
        }
    };

    const headerTitle = isVerifiedOrganizer
        ? 'Claim events you organize'
        : 'Become a verified organizer';

    return (
        <section className="rounded-lg border border-slate-200 bg-white p-6 mb-6">
            <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                aria-expanded={!collapsed}
                className="flex w-full items-center justify-between gap-2 mb-2 text-left"
            >
                <div className="flex items-center gap-2">
                    <span
                        className={`inline-block text-slate-400 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                        aria-hidden="true"
                    >
                        ▶
                    </span>
                    <h2 className="text-base text-sm font-semibold text-slate-900">
                        {headerTitle}
                    </h2>
                </div>
                <div className="flex items-center gap-1">
                    {(pendingBadgeClaim || pendingEventsClaim) && statusBadge('pending')}
                    {isVerifiedOrganizer && (
                        <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-emerald-100 text-emerald-700 inline-flex items-center gap-1">
                            <img
                                src="/orga.png"
                                alt=""
                                aria-hidden="true"
                                className="w-3 h-3 object-contain"
                            />
                            verified organizer
                        </span>
                    )}
                </div>
            </button>
            {!collapsed && (
                <>
                    {error && (
                        <div className="text-xs bg-red-50 border border-red-200 text-red-700 p-2 mb-3">
                            {error}
                        </div>
                    )}
                    {message && (
                        <div className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-700 p-2 mb-3">
                            {message}
                        </div>
                    )}

                    {/* Flow A — not yet verified: badge claim form. */}
                    {!isVerifiedOrganizer && (
                        <>
                            <p className="text-xs text-slate-500 mb-3">
                                Request the verified-organizer badge. Once approved
                                you'll be able to claim individual events you
                                organize.
                            </p>

                            {!prerequisitesMet && (
                                <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 p-2 mb-3">
                                    Before submitting a claim you must add{' '}
                                    {!hasBio && <strong>a profile bio</strong>}
                                    {!hasBio && !hasSocial && ' and '}
                                    {!hasSocial && (
                                        <strong>at least one social link</strong>
                                    )}{' '}
                                    above.
                                </div>
                            )}

                            {!pendingBadgeClaim && prerequisitesMet && (
                                <div className="mb-4">
                                    <button
                                        disabled={submitting}
                                        onClick={submitBadge}
                                        className="bg-blue-500 text-white text-xs px-3 py-1.5 hover:bg-blue-600 disabled:opacity-50"
                                    >
                                        {submitting
                                            ? 'Submitting…'
                                            : 'Request verified-organizer badge'}
                                    </button>
                                </div>
                            )}

                            {pendingBadgeClaim && (
                                <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 p-2 mb-3">
                                    Your verified-organizer request is pending admin
                                    review.
                                </div>
                            )}
                        </>
                    )}

                    {/* Flow B — already verified: events claim form. */}
                    {isVerifiedOrganizer && (
                        <>
                            <p className="text-xs text-slate-500 mb-3">
                                Search the catalogue and pick the events you
                                organize. On approval, each event will be
                                attributed to you and added to your public
                                calendar as Going.
                            </p>

                            {pendingEventsClaim && (
                                <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 p-2 mb-3">
                                    You have a pending event claim awaiting admin
                                    review. You can submit another batch once
                                    that one is decided.
                                </div>
                            )}

                            {!pendingEventsClaim && (
                                <div className="mb-4">
                                    <div className="text-xs font-medium text-slate-700 mb-1">
                                        Find events ({picked.length} picked, max 20)
                                    </div>
                                    <div className="relative">
                                        <input
                                            type="text"
                                            value={searchQ}
                                            onChange={(e) => setSearchQ(e.target.value)}
                                            placeholder="Type at least 2 characters…"
                                            className="w-full text-xs border border-slate-300 px-2 py-1.5 focus:outline-none focus:border-blue-500"
                                        />
                                        {(searching || searchResults.length > 0) && (
                                            <div className="absolute left-0 right-0 mt-1 z-10 bg-white border border-slate-200 shadow-lg max-h-56 overflow-y-auto">
                                                {searching && (
                                                    <div className="text-xs text-slate-400 px-2 py-1.5">
                                                        Searching…
                                                    </div>
                                                )}
                                                {!searching &&
                                                    searchResults.length === 0 && (
                                                        <div className="text-xs text-slate-400 px-2 py-1.5">
                                                            No matches.
                                                        </div>
                                                    )}
                                                {searchResults.map((r) => {
                                                    const already = picked.some(
                                                        (p) => p.event_id === r.event_id,
                                                    );
                                                    return (
                                                        <button
                                                            type="button"
                                                            key={r.event_id}
                                                            disabled={already || picked.length >= 20}
                                                            onClick={() => pickEvent(r)}
                                                            className="w-full text-left flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                                        >
                                                            <span className="flex-1 text-xs text-slate-700 truncate">
                                                                {r.title}
                                                            </span>
                                                            {r.start && (
                                                                <span className="text-[10px] text-slate-400">
                                                                    {new Date(r.start).toLocaleDateString()}
                                                                </span>
                                                            )}
                                                            {already && (
                                                                <span className="text-[10px] text-emerald-600">
                                                                    added
                                                                </span>
                                                            )}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>

                                    {picked.length > 0 && (
                                        <ul className="mt-2 border border-slate-200 max-h-48 overflow-y-auto divide-y divide-slate-100">
                                            {picked.map((p) => (
                                                <li
                                                    key={p.event_id}
                                                    className="flex items-center gap-2 px-2 py-1.5"
                                                >
                                                    <span className="flex-1 text-xs text-slate-700 truncate">
                                                        {p.title}
                                                    </span>
                                                    {p.start && (
                                                        <span className="text-[10px] text-slate-400">
                                                            {new Date(p.start).toLocaleDateString()}
                                                        </span>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => removePicked(p.event_id)}
                                                        className="text-[11px] text-red-600 hover:text-red-700"
                                                    >
                                                        Remove
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}

                                    <div className="mt-3">
                                        <button
                                            disabled={submitting || picked.length === 0}
                                            onClick={submitEvents}
                                            className="bg-blue-500 text-white text-xs px-3 py-1.5 hover:bg-blue-600 disabled:opacity-50"
                                        >
                                            {submitting
                                                ? 'Submitting…'
                                                : `Submit ${picked.length || ''} event claim${picked.length === 1 ? '' : 's'}`.trim()}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {loading && (
                        <div className="text-xs text-slate-400">Loading…</div>
                    )}

                    {claims.length > 0 && (
                        <div>
                            <div className="text-xs font-medium text-slate-700 mb-1">
                                My claims
                            </div>
                            <ul className="divide-y divide-slate-100 border border-slate-200">
                                {claims.map((c) => (
                                    <li key={c.id} className="p-2">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                {kindBadge(c.kind)}
                                                {statusBadge(c.status)}
                                                <span className="text-[11px] text-slate-500">
                                                    {new Date(c.created_at).toLocaleString()}
                                                </span>
                                            </div>
                                            {c.status === 'pending' && (
                                                <button
                                                    onClick={() => cancel(c.id)}
                                                    className="text-[11px] text-red-600 hover:text-red-700"
                                                >
                                                    Cancel
                                                </button>
                                            )}
                                        </div>
                                        {c.events.length > 0 && (
                                            <ul className="mt-1 ml-1 text-[11px] text-slate-600">
                                                {c.events.map((e) => (
                                                    <li
                                                        key={e.event_id}
                                                        className="flex items-center gap-2"
                                                    >
                                                        <span>•</span>
                                                        <span className="truncate flex-1">
                                                            {e.event_title ?? e.event_id}
                                                        </span>
                                                        {statusBadge(e.decision)}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                        {c.admin_notes && (
                                            <div className="mt-1 text-[11px] italic text-slate-500">
                                                Admin notes: {c.admin_notes}
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
