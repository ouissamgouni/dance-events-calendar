/**
 * Dance Passport — a dancer's private journey. Self-only page: owns data
 * fetching + owner controls (share, milestone-ack toast) and renders the
 * shared read-only PassportView.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Image, Link2, Pencil, Share2, X } from 'lucide-react';
import {
    ackPassportMilestones,
    createPassportShare,
    fetchEvent,
    fetchPassport,
    fetchPassportEvents,
    fetchPassportShare,
    fetchPassportTimeline,
    fetchPublicProfile,
    revokePassportShare,
    updateMyVisibility,
    type PublicProfile,
} from '../api';
import { useAuth } from '../context/AuthContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useToast } from '../components/Toast';
import ExplorerEventSearch from '../components/ExplorerEventSearch';
import PassportView from '../components/PassportView';
import PassportShareCard from '../components/PassportShareCard';
import SuggestEventModal from '../components/SuggestEventModal';
import { scopePassport, type ShareScope } from '../utils/passportScope';
import { CARD_HEIGHT, CARD_WIDTH, downloadImage, renderCardToBlob, shareImage } from '../utils/passportShareImage';
import type {
    CalendarEvent,
    PassportMapEvent,
    PassportResponse,
    PassportTimelineItem,
    PassportTimelineMarker,
} from '../types';

const PAGE_SIZE = 20;

const PASSPORT_SECTION_TOGGLES: {
    key: 'passport_show_badges' | 'passport_show_cities' | 'passport_show_countries' | 'passport_show_timeline';
    label: string;
    hint: string;
}[] = [
        { key: 'passport_show_badges', label: 'Badges', hint: 'Milestones you have unlocked.' },
        { key: 'passport_show_cities', label: 'Cities', hint: 'Map of cities you have danced in.' },
        { key: 'passport_show_countries', label: 'Countries', hint: 'Map of countries you have danced in.' },
        { key: 'passport_show_timeline', label: 'Timeline', hint: 'Chronological list of events you attended.' },
    ];

/**
 * Share dialog opened from the "Share my passport" button. Combines the
 * owner-only privacy controls (who may see it + which sections) with the
 * actual share action: minting the link, applying the per-share "signed-in
 * only" option, then invoking the native share sheet (with clipboard copy
 * fallback). Visibility/section changes persist via PATCH /me/visibility.
 */
function SharePassportModal({ handle, onClose }: { handle: string; onClose: () => void }) {
    const toast = useToast();
    const [profile, setProfile] = useState<PublicProfile | null>(null);
    const [requireSignin, setRequireSignin] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [share, setShare] = useState<{ token: string; require_signin: boolean } | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetchPublicProfile(handle)
            .then((p) => { if (!cancelled) setProfile(p); })
            .catch(() => { /* non-fatal: controls just stay hidden */ });
        return () => { cancelled = true; };
    }, [handle]);

    // Load the live share link (if any) so the dialog can show it and offer
    // "Stop sharing" without minting a new token just by opening.
    useEffect(() => {
        let cancelled = false;
        fetchPassportShare()
            .then((s) => {
                if (cancelled || !s) return;
                setShare(s);
                setRequireSignin(s.require_signin);
            })
            .catch(() => { /* non-fatal: no existing link */ });
        return () => { cancelled = true; };
    }, []);

    const shareUrl = share ? `${window.location.origin}/shared/passport/${share.token}` : null;

    const patch = useCallback(
        async (
            changes: Partial<Pick<
                PublicProfile,
                | 'passport_show_badges'
                | 'passport_show_cities'
                | 'passport_show_countries'
                | 'passport_show_timeline'
            >>,
        ) => {
            if (!profile) return;
            const prev = profile;
            setProfile({ ...profile, ...changes });
            try {
                await updateMyVisibility(changes);
            } catch {
                setProfile(prev);
                toast.push({
                    title: 'Could not save',
                    message: 'Please try again.',
                    variant: 'error',
                });
            }
        },
        [profile, toast],
    );

    const handleShare = useCallback(async () => {
        setSharing(true);
        try {
            const created = await createPassportShare({ require_signin: requireSignin });
            setShare(created);
            const url = `${window.location.origin}/shared/passport/${created.token}`;
            // Prefer the native share sheet; fall back to clipboard copy.
            if (navigator.share) {
                try {
                    await navigator.share({ title: 'My Dance Passport', url });
                    return;
                } catch {
                    // User cancelled or share failed — fall through to copy.
                }
            }
            let copied = false;
            try {
                await navigator.clipboard?.writeText(url);
                copied = true;
            } catch {
                copied = false;
            }
            toast.push({
                title: copied ? 'Share link copied' : 'Your passport link',
                message: url,
                variant: 'success',
            });
        } catch {
            toast.push({
                title: 'Could not create a share link',
                message: 'Please try again.',
                variant: 'error',
            });
        } finally {
            setSharing(false);
        }
    }, [requireSignin, toast]);

    // Changing who can open the link updates the existing token in place (a
    // no-op mint that re-applies the flag), so edits take effect instantly.
    const setAccess = useCallback(
        async (next: boolean) => {
            setRequireSignin(next);
            if (!share) return;
            try {
                const updated = await createPassportShare({ require_signin: next });
                setShare(updated);
                toast.push({
                    title: 'Link updated',
                    message: next
                        ? 'Only signed-in dancers can open your link now.'
                        : 'Anyone with the link can open it now.',
                    variant: 'success',
                });
            } catch {
                toast.push({ title: 'Could not update link', variant: 'error' });
            }
        },
        [share, toast],
    );

    const handleCopy = useCallback(async () => {
        if (!shareUrl) return;
        try {
            await navigator.clipboard?.writeText(shareUrl);
            toast.push({ title: 'Share link copied', variant: 'success' });
        } catch {
            toast.push({ title: 'Your passport link', message: shareUrl, variant: 'info' });
        }
    }, [shareUrl, toast]);

    const handleRevoke = useCallback(async () => {
        setBusy(true);
        try {
            await revokePassportShare();
            setShare(null);
            toast.push({
                title: 'Sharing stopped',
                message: 'Your old link no longer works.',
                variant: 'success',
            });
        } catch {
            toast.push({ title: 'Could not stop sharing', variant: 'error' });
        } finally {
            setBusy(false);
        }
    }, [toast]);

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Share your Dance Passport"
        >
            <div
                className="max-h-[92dvh] w-full max-w-md overflow-hidden rounded-t-card bg-surface shadow-xl sm:rounded-card sm:border sm:border-line"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                    <h2 className="text-sm font-semibold text-ink">Share my passport</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="text-muted hover:text-ink-soft"
                    >
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>

                <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
                    <fieldset>
                        <legend className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                            Sections to share
                        </legend>
                        <p className="mt-1 text-xs text-ink-soft">Your stats are always shown.</p>
                        <div className="mt-2 space-y-2">
                            {PASSPORT_SECTION_TOGGLES.map((row) => (
                                <label key={row.key} className="flex items-start gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={profile?.[row.key] ?? true}
                                        onChange={(e) => patch({ [row.key]: e.target.checked })}
                                        disabled={!profile}
                                        className="mt-0.5"
                                    />
                                    <span>
                                        <span className="font-medium text-ink">{row.label}</span>
                                        <span className="block text-xs text-ink-soft">{row.hint}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    <fieldset>
                        <legend className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                            Link access
                        </legend>
                        <div className="mt-2 space-y-2">
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="radio"
                                    name="passport-require-signin"
                                    checked={!requireSignin}
                                    onChange={() => setAccess(false)}
                                    className="mt-0.5"
                                />
                                <span>
                                    <span className="font-medium text-ink">Anyone with the link</span>
                                    <span className="block text-xs text-ink-soft">No sign-in required to open.</span>
                                </span>
                            </label>
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="radio"
                                    name="passport-require-signin"
                                    checked={requireSignin}
                                    onChange={() => setAccess(true)}
                                    className="mt-0.5"
                                />
                                <span>
                                    <span className="font-medium text-ink">Only signed-in dancers</span>
                                    <span className="block text-xs text-ink-soft">Viewers must sign in to open the link.</span>
                                </span>
                            </label>
                        </div>
                    </fieldset>

                    {shareUrl && (
                        <fieldset>
                            <legend className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                                Your share link
                            </legend>
                            <div className="mt-2 flex gap-2">
                                <input
                                    type="text"
                                    readOnly
                                    value={shareUrl}
                                    onFocus={(e) => e.currentTarget.select()}
                                    className="min-w-0 flex-1 border border-line bg-canvas px-2 py-1.5 text-xs text-ink"
                                />
                                <button
                                    type="button"
                                    onClick={handleCopy}
                                    className="whitespace-nowrap border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas"
                                >
                                    Copy
                                </button>
                            </div>
                            <p className="mt-1 text-xs text-ink-soft">
                                Section and access changes apply to this link instantly.
                            </p>
                        </fieldset>
                    )}
                </div>

                <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas"
                    >
                        Close
                    </button>
                    {share ? (
                        <button
                            type="button"
                            onClick={handleRevoke}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 border border-rose-600 bg-surface px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                        >
                            {busy ? 'Stopping…' : 'Stop sharing'}
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={handleShare}
                            disabled={sharing}
                            className="inline-flex items-center gap-1.5 border border-action bg-action px-3 py-1.5 text-sm font-medium text-white hover:bg-action-strong disabled:opacity-60"
                        >
                            {sharing ? 'Preparing link…' : 'Share link'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Compact header trigger opening the two-option Passport share sheet. */
function SharePassportMenu({
    handle,
    displayName,
    shareCode,
    data,
    mapEvents,
}: {
    handle: string;
    displayName: string;
    shareCode: string | null;
    data: PassportResponse;
    mapEvents: PassportMapEvent[] | null;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [modal, setModal] = useState<'link' | 'card' | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);

    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="Share passport"
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/10"
            >
                <Share2 className="h-5 w-5" aria-hidden="true" />
            </button>
            {menuOpen && (
                <div
                    className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
                    onClick={() => setMenuOpen(false)}
                >
                    <div
                        ref={menuRef}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Share my passport"
                        className="w-full max-w-sm rounded-t-card bg-surface p-4 shadow-xl sm:rounded-card sm:border sm:border-line"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="mb-2 flex items-center justify-between">
                            <h2 className="text-sm font-semibold text-ink">Share my passport</h2>
                            <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close" className="flex h-9 w-9 items-center justify-center text-muted hover:text-ink">
                                <X className="h-5 w-5" aria-hidden="true" />
                            </button>
                        </div>
                        <div role="menu" className="divide-y divide-card-line">
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setMenuOpen(false);
                                    setModal('link');
                                }}
                                className="flex w-full items-center gap-3 px-1 py-4 text-left hover:bg-canvas"
                            >
                                <Link2 className="h-5 w-5 text-action" aria-hidden="true" />
                                <span><span className="block text-sm font-semibold text-ink">As link</span><span className="block text-xs text-ink-soft">Control who can view your passport.</span></span>
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setMenuOpen(false);
                                    setModal('card');
                                }}
                                className="flex w-full items-center gap-3 px-1 py-4 text-left hover:bg-canvas"
                            >
                                <Image className="h-5 w-5 text-brand" aria-hidden="true" />
                                <span><span className="block text-sm font-semibold text-ink">As card</span><span className="block text-xs text-ink-soft">Create a shareable image.</span></span>
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {modal === 'link' && <SharePassportModal handle={handle} onClose={() => setModal(null)} />}
            {modal === 'card' && (
                <SharePassportCardModal
                    handle={handle}
                    displayName={displayName}
                    shareCode={shareCode}
                    data={data}
                    mapEvents={mapEvents}
                    onClose={() => setModal(null)}
                />
            )}
        </div>
    );
}

const CARD_PREVIEW_SCALE = 0.55;

/**
 * Dedicated "Share as card" dialog: a live preview of the branded Story card
 * plus explicit Share (native sheet) and Download actions. Kept separate from
 * the link-sharing modal because the card is a curated social artefact, not a
 * privacy control — though it still honours the owner's section toggles and
 * shares the same public link (so its QR resolves).
 */
function SharePassportCardModal({
    handle,
    displayName,
    shareCode,
    data,
    mapEvents,
    onClose,
}: {
    handle: string;
    displayName: string;
    shareCode: string | null;
    data: PassportResponse;
    mapEvents: PassportMapEvent[] | null;
    onClose: () => void;
}) {
    const toast = useToast();
    const currentYear = new Date().getFullYear();
    const [scope, setScope] = useState<ShareScope>('all');
    const [events, setEvents] = useState<PassportMapEvent[] | null>(mapEvents);
    const [profileUrl, setProfileUrl] = useState<string | null>(null);
    const [sections, setSections] = useState({ badges: true, map: true, dancingSince: false, activity: true });
    const [busy, setBusy] = useState(false);
    const cardRef = useRef<HTMLDivElement>(null);
    // On open: build the profile link the QR resolves to (always available for a
    // valid handle, even when the passport is private — the profile shows the
    // dancer + a Follow gate), load the full event set for the scoped stats/map,
    // and read the owner's section toggles.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                let url = `${window.location.origin}/u/${handle}`;
                if (shareCode) {
                    try {
                        const u = new URL(url);
                        u.searchParams.set('ref', 'share');
                        u.searchParams.set('src', shareCode);
                        url = u.toString();
                    } catch {
                        // keep the plain link
                    }
                }
                const evs = mapEvents ?? (await fetchPassportEvents());
                const profile = await fetchPublicProfile(handle).catch(() => null);
                if (cancelled) return;
                setProfileUrl(url);
                setEvents(evs);
                if (profile) {
                    setSections((s) => ({
                        ...s,
                        badges: profile.passport_show_badges ?? true,
                        map: profile.passport_show_cities ?? true,
                    }));
                }
            } catch {
                if (!cancelled) {
                    toast.push({ title: 'Could not prepare the card', variant: 'error' });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [handle, shareCode, mapEvents, toast]);

    const scoped = useMemo(
        () =>
            events
                ? scopePassport(
                    events,
                    data.milestones,
                    scope,
                    data.stats.top_style,
                    data.stats.reviews_written,
                    data.consistency,
                )
                : null,
        [
            events,
            data.milestones,
            data.stats.top_style,
            data.stats.reviews_written,
            data.consistency,
            scope,
        ],
    );

    const filename = `dance-passport-${scope === 'all' ? 'alltime' : scope}.png`;

    const generate = useCallback(async () => {
        if (!cardRef.current) throw new Error('card not ready');
        return renderCardToBlob(cardRef.current);
    }, []);

    const handleShare = useCallback(async () => {
        setBusy(true);
        try {
            const blob = await generate();
            const result = await shareImage(blob, filename, { title: 'My Dance Passport' });
            if (result === 'unsupported') {
                downloadImage(blob, filename);
                toast.push({ title: 'Image saved', variant: 'success' });
            }
        } catch {
            toast.push({ title: 'Could not create the image', variant: 'error' });
        } finally {
            setBusy(false);
        }
    }, [generate, filename, toast]);

    const handleDownload = useCallback(async () => {
        setBusy(true);
        try {
            const blob = await generate();
            downloadImage(blob, filename);
            toast.push({
                title: 'Image saved',
                message: 'Your passport card was downloaded.',
                variant: 'success',
            });
        } catch {
            toast.push({ title: 'Could not create the image', variant: 'error' });
        } finally {
            setBusy(false);
        }
    }, [generate, filename, toast]);

    const ready = scoped != null && profileUrl != null;

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Share your Dance Passport as a card"
        >
            <div
                className="max-h-[92dvh] w-full max-w-sm overflow-y-auto rounded-t-card bg-surface shadow-xl sm:rounded-card sm:border sm:border-line"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                    <h2 className="text-sm font-semibold text-ink">Share as card</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="text-muted hover:text-ink-soft"
                    >
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>

                <div className="space-y-4 px-4 py-4">
                    <div className="inline-flex border border-line">
                        <button
                            type="button"
                            aria-pressed={scope === 'all'}
                            onClick={() => setScope('all')}
                            className={
                                scope === 'all'
                                    ? 'bg-action px-3 py-1.5 text-sm font-medium text-white'
                                    : 'bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas'
                            }
                        >
                            All time
                        </button>
                        <button
                            type="button"
                            aria-pressed={scope === currentYear}
                            onClick={() => setScope(currentYear)}
                            className={
                                scope === currentYear
                                    ? 'border-l border-line bg-action px-3 py-1.5 text-sm font-medium text-white'
                                    : 'border-l border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas'
                            }
                        >
                            {currentYear}
                        </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                        <label className="inline-flex items-center gap-2 text-sm text-ink">
                            <input
                                type="checkbox"
                                checked={sections.map}
                                onChange={(e) => setSections((s) => ({ ...s, map: e.target.checked }))}
                            />
                            Map
                        </label>
                        <label className="inline-flex items-center gap-2 text-sm text-ink">
                            <input
                                type="checkbox"
                                checked={sections.badges}
                                onChange={(e) => setSections((s) => ({ ...s, badges: e.target.checked }))}
                            />
                            Badges
                        </label>
                        <label className="inline-flex items-center gap-2 text-sm text-ink">
                            <input
                                type="checkbox"
                                checked={sections.activity}
                                onChange={(e) => setSections((s) => ({ ...s, activity: e.target.checked }))}
                            />
                            Activity
                        </label>
                    </div>

                    {ready ? (
                        <div
                            className="mx-auto overflow-hidden border border-line"
                            style={{
                                width: CARD_WIDTH * CARD_PREVIEW_SCALE,
                                height: CARD_HEIGHT * CARD_PREVIEW_SCALE,
                            }}
                        >
                            <div
                                style={{
                                    width: CARD_WIDTH,
                                    height: CARD_HEIGHT,
                                    transform: `scale(${CARD_PREVIEW_SCALE})`,
                                    transformOrigin: 'top left',
                                }}
                            >
                                <div ref={cardRef}>
                                    <PassportShareCard
                                        displayName={displayName}
                                        handle={handle}
                                        scoped={scoped}
                                        memberSince={data.stats.member_since}
                                        dancingSince={data.stats.dancing_since}
                                        profileUrl={profileUrl}
                                        showBadges={sections.badges}
                                        showMap={sections.map}
                                        showDancingSince={sections.dancingSince}
                                        showActivity={sections.activity}
                                    />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div
                            className="mx-auto flex items-center justify-center border border-line bg-canvas text-xs text-ink-soft"
                            style={{
                                width: CARD_WIDTH * CARD_PREVIEW_SCALE,
                                height: CARD_HEIGHT * CARD_PREVIEW_SCALE,
                            }}
                        >
                            Preparing your card…
                        </div>
                    )}
                </div>

                <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas"
                    >
                        Close
                    </button>
                    <button
                        type="button"
                        onClick={handleDownload}
                        disabled={!ready || busy}
                        className="border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        Download
                    </button>
                    <button
                        type="button"
                        onClick={handleShare}
                        disabled={!ready || busy}
                        className="border border-action bg-action px-3 py-1.5 text-sm font-medium text-white hover:bg-action-strong disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        Share
                    </button>
                </div>
            </div>
        </div>
    );
}

function formatJourneyDate(iso: string): string {
    try {
        return new Date(iso).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    } catch {
        return iso;
    }
}

/**
 * Owner-only "Dancing since" line for the passport overview: shows the
 * effective start date (user-set ``dancing_since`` or the account date) with an
 * inline date editor, plus the first Movida event date for context.
 */
function DancingSinceControl({
    dancingSince,
    memberSince,
    firstEventDate,
    onSaved,
}: {
    dancingSince: string | null;
    memberSince: string;
    firstEventDate: string | null;
    onSaved: (iso: string) => void;
}) {
    const toast = useToast();
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState('');
    const [saving, setSaving] = useState(false);
    const effective = dancingSince ?? memberSince;
    const today = new Date().toISOString().slice(0, 10);

    const startEdit = () => {
        setValue((dancingSince ?? memberSince ?? '').slice(0, 10));
        setEditing(true);
    };

    const save = async () => {
        if (!value) return;
        setSaving(true);
        try {
            await updateMyVisibility({ dancing_since: value });
            onSaved(value);
            setEditing(false);
            toast.push({ title: 'Saved', variant: 'success' });
        } catch {
            toast.push({ title: 'Could not save', variant: 'error' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="text-xs text-slate-300">
            {editing ? (
                <div className="flex flex-wrap items-center gap-2">
                    <span>Dancing since</span>
                    <input
                        type="date"
                        value={value}
                        max={today}
                        onChange={(e) => setValue(e.target.value)}
                        aria-label="Dancing since"
                        className="border border-slate-600 bg-slate-800 px-2 py-1 text-white"
                    />
                    <button
                        type="button"
                        onClick={save}
                        disabled={saving || !value}
                        className="border border-action bg-action px-2 py-1 font-medium text-white hover:bg-action-strong disabled:opacity-60"
                    >
                        Save
                    </button>
                    <button
                        type="button"
                        onClick={() => setEditing(false)}
                        className="border border-slate-600 bg-slate-800 px-2 py-1 font-medium text-slate-200 hover:bg-slate-700"
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                    <span>Dancing since {formatJourneyDate(effective)}</span>
                    <button
                        type="button"
                        onClick={startEdit}
                        className="inline-flex items-center text-white/60 hover:text-white shrink-0"
                        aria-label="Edit dancing since date"
                    >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>
            )}
            {firstEventDate && (
                <p className="mt-0.5 text-muted text-[10px]">
                    First event on Movida {formatJourneyDate(firstEventDate)}
                </p>
            )}
        </div>
    );
}

function formatEventDates(event: CalendarEvent): string {
    const opts: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    };
    try {
        const start = new Date(event.start);
        const end = event.end ? new Date(event.end) : null;
        const startStr = start.toLocaleString(undefined, event.all_day
            ? { year: 'numeric', month: 'short', day: 'numeric' }
            : opts);
        if (!end || event.all_day || end.getTime() === start.getTime()) return startStr;
        const sameDay = start.toDateString() === end.toDateString();
        const endStr = end.toLocaleString(
            undefined,
            sameDay ? { hour: 'numeric', minute: '2-digit' } : opts,
        );
        return `${startStr} – ${endStr}`;
    } catch {
        return event.start;
    }
}

const DESCRIPTION_PREVIEW_CHARS = 220;

/**
 * Confirmation dialog shown after picking a past event to add. Loads the full
 * event, shows its details (with a truncated description + "See more" and a
 * link to the details page) and asks the owner to confirm they attended before
 * recording a "Going" attendance that feeds the passport.
 */
function AttendedEventConfirmModal({
    eventId,
    onClose,
    onConfirmed,
}: {
    eventId: string;
    onClose: () => void;
    onConfirmed: () => void;
}) {
    const toast = useToast();
    const { isAttending, toggleAttending } = useAttendingEvents();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetchEvent(eventId)
            .then((e) => { if (!cancelled) setEvent(e); })
            .catch(() => { if (!cancelled) setLoadError(true); });
        return () => { cancelled = true; };
    }, [eventId]);

    const confirm = useCallback(async () => {
        setSaving(true);
        try {
            if (isAttending(eventId)) {
                toast.push({
                    title: 'Already in your passport',
                    message: 'You already marked this event as attended.',
                    variant: 'info',
                });
                onConfirmed();
                return;
            }
            const ok = await toggleAttending(eventId);
            if (ok) {
                toast.push({
                    title: 'Added to your passport',
                    message: event?.title ?? 'Event added.',
                    variant: 'success',
                });
                onConfirmed();
            } else {
                toast.push({
                    title: 'Could not add the event',
                    message: 'Please try again.',
                    variant: 'error',
                });
            }
        } finally {
            setSaving(false);
        }
    }, [eventId, isAttending, toggleAttending, toast, event, onConfirmed]);

    const description = event?.description ?? '';
    const isLong = description.length > DESCRIPTION_PREVIEW_CHARS;
    const shownDescription = expanded || !isLong
        ? description
        : `${description.slice(0, DESCRIPTION_PREVIEW_CHARS).trimEnd()}…`;

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm you attended this event"
        >
            <div
                className="w-full max-w-md border border-line bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                    <h2 className="text-sm font-semibold text-ink">Add a past event</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="text-muted hover:text-ink-soft"
                    >
                        ✕
                    </button>
                </div>

                <div className="max-h-[70vh] space-y-3 overflow-y-auto px-4 py-4">
                    {loadError ? (
                        <p className="text-sm text-danger">Could not load this event. Please try again.</p>
                    ) : !event ? (
                        <p className="text-sm text-ink-soft">Loading event…</p>
                    ) : (
                        <>
                            <div>
                                <h3 className="text-base font-semibold text-ink">{event.title}</h3>
                                <p className="mt-1 text-sm text-ink-soft">{formatEventDates(event)}</p>
                                {event.location && (
                                    <p className="mt-0.5 text-sm text-ink-soft">{event.location}</p>
                                )}
                            </div>
                            {description && (
                                <p className="whitespace-pre-line text-sm text-ink">
                                    {shownDescription}
                                    {isLong && (
                                        <button
                                            type="button"
                                            onClick={() => setExpanded((v) => !v)}
                                            className="ml-1 font-medium text-action hover:underline"
                                        >
                                            {expanded ? 'See less' : 'See more'}
                                        </button>
                                    )}
                                </p>
                            )}
                            <Link
                                to={`/event/${eventId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-block text-sm font-medium text-action hover:underline"
                            >
                                See details →
                            </Link>
                            <p className="border-t border-card-line pt-3 text-sm font-medium text-ink">
                                Did you really attend this event?
                            </p>
                        </>
                    )}
                </div>

                <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={confirm}
                        disabled={saving || !event}
                        className="inline-flex items-center gap-1.5 border border-action bg-action px-3 py-1.5 text-sm font-medium text-white hover:bg-action-strong disabled:opacity-60"
                    >
                        {saving ? 'Adding…' : 'Yes, I attended'}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * "Add a past event" control: reuses the app-header event search (scoped to
 * past events) to pick an event, then confirms attendance before it is added
 * to the passport.
 */
function AddPastEventControl({ onAdded, onOpenSubmitEvent }: { onAdded: () => void; onOpenSubmitEvent?: () => void }) {
    const [confirmId, setConfirmId] = useState<string | null>(null);
    return (
        <>
            <ExplorerEventSearch
                includePast
                small
                triggerIcon="plus"
                triggerLabel="Add past event"
                onSelectEvent={(id) => setConfirmId(id)}
                onOpenSubmitEvent={onOpenSubmitEvent}
            />
            {confirmId && (
                <AttendedEventConfirmModal
                    eventId={confirmId}
                    onClose={() => setConfirmId(null)}
                    onConfirmed={() => {
                        setConfirmId(null);
                        onAdded();
                    }}
                />
            )}
        </>
    );
}

export default function PassportPage() {
    const { user, loading: authLoading } = useAuth();
    const toast = useToast();
    const [data, setData] = useState<PassportResponse | null>(null);
    const [items, setItems] = useState<PassportTimelineItem[]>([]);
    const [markers, setMarkers] = useState<PassportTimelineMarker[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mapEvents, setMapEvents] = useState<PassportMapEvent[] | null>(null);
    const [showSuggestModal, setShowSuggestModal] = useState(false);
    const timelineQueryRef = useRef('');
    const timelineRequestRef = useRef(0);
    const mapEventsRef = useRef(false);
    const celebratedRef = useRef(false);

    useEffect(() => {
        if (authLoading || !user) return;
        let cancelled = false;
        setLoading(true);
        Promise.all([fetchPassport(), fetchPassportTimeline(0, PAGE_SIZE)])
            .then(([passport, timeline]) => {
                if (cancelled) return;
                setData(passport);
                setItems(timeline.items);
                setMarkers(timeline.markers);
                setTotal(timeline.total);
                // Celebrate newly-unlocked milestones once, then acknowledge so
                // the toast never re-fires on the next open.
                if (!celebratedRef.current) {
                    const fresh = passport.milestones.filter((m) => m.is_new);
                    const freshConsistency = passport.consistency?.new ?? [];
                    if (fresh.length > 0 || freshConsistency.length > 0) {
                        celebratedRef.current = true;
                        fresh.forEach((m) =>
                            toast.push({
                                title: `${m.icon} Milestone unlocked!`,
                                message: m.name,
                                variant: 'success',
                            }),
                        );
                        freshConsistency.forEach((c) =>
                            toast.push({
                                title: `${c.icon} ${c.name}!`,
                                message: 'Consistency achievement reached',
                                variant: 'success',
                            }),
                        );
                        ackPassportMilestones(
                            fresh.map((m) => m.key),
                            freshConsistency.map((c) => `${c.key}:${c.period_start}`),
                        ).catch(() => {
                            // Non-fatal: the toast still showed; retry on next open.
                        });
                    }
                }
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [authLoading, user, toast]);

    const loadMore = useCallback(async () => {
        setLoadingMore(true);
        try {
            const next = await fetchPassportTimeline(items.length, PAGE_SIZE, timelineQueryRef.current);
            setItems((prev) => [...prev, ...next.items]);
            setTotal(next.total);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoadingMore(false);
        }
    }, [items.length]);

    const searchTimeline = useCallback(async (query: string) => {
        const normalized = query.trim();
        if (normalized === timelineQueryRef.current) return;
        timelineQueryRef.current = normalized;
        const request = ++timelineRequestRef.current;
        try {
            const timeline = await fetchPassportTimeline(0, PAGE_SIZE, normalized);
            if (request !== timelineRequestRef.current) return;
            setItems(timeline.items);
            setMarkers(timeline.markers);
            setTotal(timeline.total);
        } catch (e: unknown) {
            if (request === timelineRequestRef.current) {
                setError(e instanceof Error ? e.message : String(e));
            }
        }
    }, []);

    const hasMore = useMemo(() => items.length < total, [items.length, total]);

    // Lazily load the full attended-event set for the Cities/Countries map the
    // first time the viewer opens one of those tabs.
    const loadMapEvents = useCallback(() => {
        if (mapEventsRef.current) return;
        mapEventsRef.current = true;
        fetchPassportEvents()
            .then(setMapEvents)
            .catch((e: unknown) => {
                mapEventsRef.current = false;
                setError(e instanceof Error ? e.message : String(e));
            });
    }, []);

    // Re-fetch the passport after the owner adds a past event so the new
    // stats/timeline (and any milestone it unlocks) show immediately.
    const handlePastEventAdded = useCallback(async () => {
        try {
            const [passport, timeline] = await Promise.all([
                fetchPassport(),
                fetchPassportTimeline(0, PAGE_SIZE),
            ]);
            setData(passport);
            setItems(timeline.items);
            setMarkers(timeline.markers);
            setTotal(timeline.total);
            const fresh = passport.milestones.filter((m) => m.is_new);
            const freshConsistency = passport.consistency?.new ?? [];
            if (fresh.length > 0 || freshConsistency.length > 0) {
                fresh.forEach((m) =>
                    toast.push({
                        title: `${m.icon} Milestone unlocked!`,
                        message: m.name,
                        variant: 'success',
                    }),
                );
                freshConsistency.forEach((c) =>
                    toast.push({
                        title: `${c.icon} ${c.name}!`,
                        message: 'Consistency achievement reached',
                        variant: 'success',
                    }),
                );
                ackPassportMilestones(
                    fresh.map((m) => m.key),
                    freshConsistency.map((c) => `${c.key}:${c.period_start}`),
                ).catch(() => { });
            }
            // Invalidate the lazily-loaded map so the new city/country appears.
            mapEventsRef.current = false;
            setMapEvents(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [toast]);

    if (!authLoading && !user) {
        return (
            <div className="mx-auto max-w-2xl p-6">
                <div className="border border-line bg-surface p-6 text-center">
                    <h1 className="text-lg font-semibold text-ink">Your Dance Passport</h1>
                    <p className="mt-2 text-sm text-ink-soft">
                        Sign in to track your dance journey.
                    </p>
                    <Link
                        to="/login"
                        className="mt-4 inline-block bg-action px-4 py-2 text-sm font-medium text-white hover:bg-action"
                    >
                        Sign in
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-4xl space-y-6 p-4">
            {error && (
                <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">
                    {error}
                </div>
            )}

            {loading || !data ? (
                <div className="border border-line bg-surface p-6 text-center text-sm text-ink-soft">
                    Loading your passport…
                </div>
            ) : (
                <>
                    <PassportView
                        data={data}
                        displayName={(user?.name || '').trim().split(/\s+/)[0] || user?.handle || 'Dancer'}
                        handle={user?.handle ?? null}
                        avatarUrl={user?.avatar_url ?? null}
                        headerActions={
                            user?.handle ? (
                                <SharePassportMenu
                                    handle={user.handle}
                                    displayName={(user.name || '').trim().split(/\s+/)[0] || user.handle}
                                    shareCode={user.share_code ?? null}
                                    data={data}
                                    mapEvents={mapEvents}
                                />
                            ) : undefined
                        }
                        dancingSinceSlot={
                            <DancingSinceControl
                                dancingSince={data.stats.dancing_since}
                                memberSince={data.stats.member_since}
                                firstEventDate={data.stats.first_event_date}
                                onSaved={(iso) =>
                                    setData((d) =>
                                        d ? { ...d, stats: { ...d.stats, dancing_since: iso } } : d,
                                    )
                                }
                            />
                        }
                        timelineActions={<AddPastEventControl onAdded={handlePastEventAdded} onOpenSubmitEvent={() => setShowSuggestModal(true)} />}
                        timelineItems={items}
                        timelineMarkers={markers}
                        timelineHasMore={hasMore}
                        onLoadMoreTimeline={loadMore}
                        loadingMoreTimeline={loadingMore}
                        mapEvents={mapEvents}
                        onNeedMapEvents={loadMapEvents}
                        onTimelineSearch={searchTimeline}
                    />
                </>
            )}
            {showSuggestModal && (
                <SuggestEventModal onClose={() => setShowSuggestModal(false)} />
            )}
        </div>
    );
}
