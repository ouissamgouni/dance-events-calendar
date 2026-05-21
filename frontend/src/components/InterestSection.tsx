/**
 * Phase E (E5 follow-up) — merged "Interest" section.
 *
 * Replaces the previous split "Who's going" (AttendeeList) + "Who you
 * know going" (GoingWedge) blocks on the event detail view with a
 * single section that:
 *   1. Renders a counts row (N going · M saved).
 *   2. Renders three horizontal chip rows in priority order, deduped
 *      by user_id:
 *        a. Friends going        — bold chip, no Follow CTA
 *        b. Friends of friends   — chip + "via @alice" + inline Follow
 *        c. Also going (public)  — muted chip + inline Follow
 *   3. Caps each bucket inline (Friends 6, FoF 3, Also going 6) and
 *      shows a "Show all N →" link when overflow exists, opening a
 *      modal with three stacked sections (no tabs).
 *
 * Anon viewers see counts + sign-in CTA only (no wedge request).
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
    fetchAttendanceSummary,
    fetchEventAttendees,
    fetchGoingWedge,
    followUser,
    type FofGoingAttendee,
    type GoingWedgeResponse,
    type WedgeAttendee,
} from '../api';
import type { Attendee, AttendanceSummary } from '../types';
import { useAuth } from '../context/AuthContext';
import { useAttendanceInvalidationKey } from '../context/AttendanceSummariesContext';

interface Props {
    eventId: string;
    eventTitle: string;
}

const FRIENDS_INLINE_CAP = 6;
const FOF_INLINE_CAP = 3;
const OTHERS_INLINE_CAP = 3;

// ---------------------------------------------------------------------------
// Avatar / chip primitives
// ---------------------------------------------------------------------------

function Avatar({
    handle,
    display_name,
    avatar_url,
    size = 'sm',
}: {
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
    size?: 'sm' | 'md';
}) {
    const px = size === 'md' ? 'h-8 w-8 text-xs' : 'h-6 w-6 text-[10px]';
    const name = display_name || handle || '?';
    if (avatar_url) {
        return (
            <img
                src={avatar_url}
                alt=""
                className={`${px} rounded-full object-cover`}
            />
        );
    }
    return (
        <span
            className={`${px} rounded-full bg-slate-200 text-slate-600 font-semibold flex items-center justify-center`}
            aria-hidden="true"
        >
            {name.trim()[0]?.toUpperCase() ?? '?'}
        </span>
    );
}

type ChipVariant = 'friend' | 'fof' | 'other';

function variantClasses(variant: ChipVariant): string {
    switch (variant) {
        case 'friend':
            return 'bg-blue-50 border border-blue-100 text-blue-900';
        case 'fof':
            return 'bg-white border border-slate-200 text-slate-800';
        case 'other':
            return 'bg-slate-50 border border-slate-200 text-slate-700';
    }
}

function NameLink({
    handle,
    display_name,
    className,
}: {
    handle: string | null;
    display_name: string | null;
    className?: string;
}) {
    const label = display_name || (handle ? `@${handle}` : 'Attendee');
    if (handle) {
        return (
            <Link
                to={`/u/${handle}`}
                className={`hover:underline ${className ?? ''}`}
            >
                {label}
            </Link>
        );
    }
    return <span className={className}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Inline Follow button (optimistic, no per-attendee status fetch).
// Hidden when handle is missing (anonymous attendee row).
// ---------------------------------------------------------------------------

function FollowChipButton({
    handle,
    variant = 'icon',
    initialStatus,
}: {
    handle: string | null;
    // 'icon' = compact +/✓ used inline next to chips.
    // 'text' = labelled "Follow"/"Following" pill used inside the modal,
    // where horizontal space is not constrained and the action benefits
    // from being explicit.
    variant?: 'icon' | 'text';
    initialStatus?: 'pending' | 'approved';
}) {
    const [state, setState] = useState<'idle' | 'busy' | 'followed' | 'error'>(
        initialStatus === 'approved' ? 'followed' : 'idle',
    );
    // When a pending request exists, show a non-clickable "Requested" state.
    const isPending = initialStatus === 'pending' && state === 'idle';
    if (!handle) return null;

    const onClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (state === 'busy' || state === 'followed' || isPending) return;
        setState('busy');
        try {
            await followUser(handle);
            setState('followed');
            // Notify other components (InterestSection, friends panels…)
            // that the social graph changed so they refetch any cached
            // friend/non-friend buckets they might be holding.
            window.dispatchEvent(new Event('network:changed'));
        } catch {
            setState('error');
        }
    };

    if (variant === 'text') {
        if (isPending) {
            return (
                <span
                    title={`Follow request pending for @${handle}`}
                    aria-label={`Follow request pending for @${handle}`}
                    className="inline-flex items-center justify-center px-2 py-0.5 text-[11px] leading-none text-slate-500 border border-slate-200 bg-white"
                >
                    Requested
                </span>
            );
        }
        if (state === 'followed') {
            return (
                <span
                    title={`Following @${handle}`}
                    aria-label={`Following @${handle}`}
                    className="inline-flex items-center justify-center px-2 py-0.5 text-[11px] leading-none text-slate-500 border border-slate-200 bg-white"
                >
                    Following
                </span>
            );
        }
        const busy = state === 'busy';
        const errored = state === 'error';
        const label = errored ? `Retry follow @${handle}` : `Follow @${handle}`;
        return (
            <button
                type="button"
                onClick={onClick}
                disabled={busy}
                title={label}
                aria-label={label}
                className="inline-flex items-center justify-center px-2 py-0.5 text-[11px] leading-none bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {busy ? 'Following…' : errored ? 'Retry' : 'Follow'}
            </button>
        );
    }

    if (state === 'followed') {
        // Compact "following" badge — checkmark only, with a11y label.
        return (
            <span
                title={`Following @${handle}`}
                aria-label={`Following @${handle}`}
                className="inline-flex items-center justify-center h-4 w-4 text-[10px] leading-none text-slate-500 border border-slate-200 bg-white"
            >
                ✓
            </span>
        );
    }

    if (isPending) {
        return (
            <span
                title={`Follow request pending for @${handle}`}
                aria-label={`Follow request pending for @${handle}`}
                className="inline-flex items-center justify-center h-4 w-4 text-[10px] leading-none text-slate-400 border border-slate-200 bg-white"
            >
                ·
            </span>
        );
    }

    const busy = state === 'busy';
    const errored = state === 'error';
    const label = errored ? `Retry follow @${handle}` : `Follow @${handle}`;
    // Icon-only +/↻ button. Smallest practical hit target (h-4 w-4) per
    // request — the chip row is already a compact horizontal strip.
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={busy}
            title={label}
            aria-label={label}
            className="inline-flex items-center justify-center h-4 w-4 text-[10px] leading-none bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
            {busy ? '…' : errored ? '↻' : '+'}
        </button>
    );
}

// ---------------------------------------------------------------------------
// Bucket chip rows (inline)
// ---------------------------------------------------------------------------

function FriendChip({ a }: { a: WedgeAttendee }) {
    return (
        <li
            className={`inline-flex items-center gap-1.5 pl-0.5 pr-2.5 py-0.5 ${variantClasses('friend')}`}
        >
            <Avatar
                handle={a.handle}
                display_name={a.display_name}
                avatar_url={a.avatar_url}
            />
            <NameLink
                handle={a.handle}
                display_name={a.display_name}
                className="text-xs whitespace-nowrap"
            />
        </li>
    );
}

function FofChip({ a }: { a: FofGoingAttendee }) {
    return (
        <li
            className={`inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 ${variantClasses('fof')}`}
        >
            <Avatar
                handle={a.handle}
                display_name={a.display_name}
                avatar_url={a.avatar_url}
            />
            <NameLink
                handle={a.handle}
                display_name={a.display_name}
                className="text-xs whitespace-nowrap"
            />
            {a.via_friend_handle && (
                <span className="text-[10px] text-slate-500 whitespace-nowrap">
                    · via{' '}
                    <Link
                        to={`/u/${a.via_friend_handle}`}
                        className="hover:underline"
                    >
                        @{a.via_friend_handle}
                    </Link>
                </span>
            )}
            <FollowChipButton handle={a.handle} initialStatus={a.viewer_follow_status} />
        </li>
    );
}

function OtherChip({ a, isSelf = false }: { a: Attendee; isSelf?: boolean }) {
    return (
        <li
            className={`inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 ${variantClasses('other')}`}
        >
            <Avatar
                handle={a.handle}
                display_name={a.display_name}
                avatar_url={a.avatar_url}
            />
            <NameLink
                handle={a.handle}
                display_name={a.display_name}
                className="text-xs whitespace-nowrap"
            />
            {isSelf ? (
                <span className="text-[10px] text-slate-500">(you)</span>
            ) : (
                <FollowChipButton handle={a.handle} initialStatus={a.viewer_follow_status} />
            )}
        </li>
    );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export default function InterestSection({ eventId, eventTitle }: Props) {
    const { user } = useAuth();
    const invalidationKey = useAttendanceInvalidationKey(eventId);
    const [summary, setSummary] = useState<AttendanceSummary | null>(null);
    const [summaryLoading, setSummaryLoading] = useState(true);
    const [fullList, setFullList] = useState<Attendee[] | null>(null);
    const [wedge, setWedge] = useState<GoingWedgeResponse | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    // Bumped on `network:changed` (follow/unfollow/approve/decline anywhere
    // in the app). The wedge + attendee fetches include this in their deps so
    // a user becoming a friend immediately moves them from "Also going" to
    // "Friends going" without requiring a page reload.
    const [socialVersion, setSocialVersion] = useState(0);
    useEffect(() => {
        const handler = () => setSocialVersion((v) => v + 1);
        window.addEventListener('network:changed', handler);
        return () => window.removeEventListener('network:changed', handler);
    }, []);

    // Counts: lightweight, always fetched.
    useEffect(() => {
        let cancelled = false;
        setSummaryLoading(true);
        fetchAttendanceSummary(eventId)
            .then((s) => {
                if (!cancelled) setSummary(s);
            })
            .catch(() => {
                /* keep UI quiet on error */
            })
            .finally(() => {
                if (!cancelled) setSummaryLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [eventId, user?.user_id, invalidationKey, socialVersion]);

    // Full attendee list (authed only).
    useEffect(() => {
        if (!user) {
            setFullList(null);
            return;
        }
        let cancelled = false;
        fetchEventAttendees(eventId)
            .then((res) => {
                if (cancelled) return;
                if ('unauthorized' in res) setFullList(null);
                else setFullList(res);
            })
            .catch(() => {
                /* leave fullList null */
            });
        return () => {
            cancelled = true;
        };
    }, [eventId, user?.user_id, invalidationKey, socialVersion]);

    // Wedge (authed only — backend 401s anon and we treat null as empty).
    useEffect(() => {
        if (!user) {
            setWedge(null);
            return;
        }
        let cancelled = false;
        fetchGoingWedge(eventId)
            .then((res) => {
                if (!cancelled) setWedge(res);
            })
            .catch(() => {
                /* leave wedge null */
            });
        return () => {
            cancelled = true;
        };
    }, [eventId, user?.user_id, invalidationKey, socialVersion]);

    // Compute deduped "Others" list. Friends + FoF take priority by user_id.
    const { friends, fofs, others, anonymousTail } = useMemo(() => {
        const friends = wedge?.friends_going ?? [];
        const fofs = wedge?.fof_going ?? [];
        const claimed = new Set<string>();
        for (const f of friends) claimed.add(f.user_id);
        for (const f of fofs) claimed.add(f.user_id);
        const others = (fullList ?? []).filter(
            (a) => !claimed.has(a.user_id),
        );
        const anonymousTail = Math.max(
            0,
            (wedge?.public_going_count ?? 0) - others.length,
        );
        return { friends, fofs, others, anonymousTail };
    }, [wedge, fullList]);

    const totalShown =
        friends.length + fofs.length + others.length + anonymousTail;
    const overflow =
        friends.length > FRIENDS_INLINE_CAP ||
        fofs.length > FOF_INLINE_CAP ||
        others.length > OTHERS_INLINE_CAP ||
        anonymousTail > 0;

    if (summaryLoading && !summary) {
        return (
            <div className="border-t border-slate-100 pt-3 text-xs text-slate-400">
                Loading interest…
            </div>
        );
    }
    if (!summary) return null;

    // Collapsible header (reused for anon + authed). The chevron is the
    // only visual cue — clicking the whole strip toggles, matching the
    // pattern used by other collapsible sections in the app.
    const Header = (
        <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
        >
            <span
                aria-hidden="true"
                className={`inline-block transition-transform ${collapsed ? '' : 'rotate-90'}`}
            >
                ▸
            </span>
            <img
                src="/group.png"
                alt=""
                aria-hidden="true"
                className="w-4 h-4 object-contain"
            />
            Interest
        </button>
    );

    // -----------------------------------------------------------------
    // Anonymous viewer: counts + sign-in CTA only.
    // -----------------------------------------------------------------
    if (!user) {
        return (
            <section
                className="border-t border-slate-100 pt-3 text-xs"
                data-testid="interest-section"
            >
                <div className="mb-2">{Header}</div>
                {!collapsed && (
                    <>
                        <CountsRow summary={summary} />
                        {summary.total_going > 0 && (
                            <div className="text-slate-500 mt-1">
                                Sign in to see who's going.
                            </div>
                        )}
                    </>
                )}
            </section>
        );
    }

    // -----------------------------------------------------------------
    // Authed viewer.
    // -----------------------------------------------------------------
    const isEmpty =
        friends.length === 0 &&
        fofs.length === 0 &&
        others.length === 0 &&
        anonymousTail === 0;

    return (
        <section
            className="border-t border-slate-100 pt-3 space-y-2 text-xs"
            data-testid="interest-section"
        >
            {Header}
            {!collapsed && (
                <>
                    <CountsRow summary={summary} />

                    {isEmpty ? (
                        <div className="text-[11px] text-slate-500">
                            No one has shared their name yet — be the first by marking
                            yourself going publicly.
                        </div>
                    ) : (
                        <>
                            {friends.length > 0 && (
                                <BucketRow
                                    label="★ Friends going"
                                    testid="interest-friends"
                                    count={friends.length}
                                >
                                    {friends
                                        .slice(0, FRIENDS_INLINE_CAP)
                                        .map((a) => (
                                            <FriendChip key={a.user_id} a={a} />
                                        ))}
                                </BucketRow>
                            )}
                            {fofs.length > 0 && (
                                <BucketRow
                                    label="· Friends of friends"
                                    testid="interest-fof"
                                    count={fofs.length}
                                >
                                    {fofs.slice(0, FOF_INLINE_CAP).map((a) => (
                                        <FofChip key={a.user_id} a={a} />
                                    ))}
                                </BucketRow>
                            )}
                            {others.length > 0 && (
                                <BucketRow
                                    label="· Also going"
                                    testid="interest-others"
                                    count={others.length}
                                >
                                    {others
                                        .slice(0, OTHERS_INLINE_CAP)
                                        .map((a) => (
                                            <OtherChip
                                                key={a.user_id}
                                                a={a}
                                                isSelf={a.user_id === user.user_id}
                                            />
                                        ))}
                                </BucketRow>
                            )}
                            {overflow && (
                                <div className="text-right">
                                    <button
                                        type="button"
                                        onClick={() => setModalOpen(true)}
                                        className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                                        data-testid="interest-show-all"
                                    >
                                        Show all {totalShown} →
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </>
            )}

            {modalOpen && (
                <GoingModal
                    eventTitle={eventTitle}
                    friends={friends}
                    fofs={fofs}
                    others={others}
                    anonymousTail={anonymousTail}
                    selfUserId={user.user_id}
                    onClose={() => setModalOpen(false)}
                />
            )}
        </section>
    );
}

// ---------------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------------

function CountsRow({ summary }: { summary: AttendanceSummary }) {
    return (
        <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>
                <span className="font-medium">{summary.total_going}</span> going
            </span>
            <span className="text-slate-300">·</span>
            <span>
                <span className="font-medium">{summary.total_saved}</span> saved
            </span>
        </div>
    );
}

function BucketRow({
    label,
    count,
    testid,
    children,
}: {
    label: string;
    count: number;
    testid: string;
    children: React.ReactNode;
}) {
    return (
        <div data-testid={testid}>
            <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
                {label} ({count})
            </div>
            <ul className="flex flex-wrap gap-x-2 gap-y-1 items-center">
                {children}
            </ul>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Modal — three stacked sections, no tabs.
// ---------------------------------------------------------------------------

function GoingModal({
    eventTitle,
    friends,
    fofs,
    others,
    anonymousTail,
    selfUserId,
    onClose,
}: {
    eventTitle: string;
    friends: WedgeAttendee[];
    fofs: FofGoingAttendee[];
    others: Attendee[];
    anonymousTail: number;
    selfUserId: string | undefined;
    onClose: () => void;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return createPortal(
        <div
            className="fixed inset-0 z-[10000] bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`Going to ${eventTitle}`}
                onClick={(e) => e.stopPropagation()}
                className="bg-white border border-slate-200 shadow-lg w-full sm:max-w-md max-h-[80vh] flex flex-col text-xs"
                data-testid="interest-modal"
            >
                <div className="flex items-start justify-between p-3 border-b border-slate-200">
                    <div className="min-w-0">
                        <h2 className="text-sm font-semibold text-slate-800 truncate">
                            Going to "{eventTitle}"
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="text-slate-400 hover:text-slate-600 text-xl leading-none px-1"
                    >
                        ×
                    </button>
                </div>

                <div className="overflow-y-auto flex-1">
                    <ModalSection
                        label="★ Friends going"
                        count={friends.length}
                        emptyCopy="No friends going yet."
                    >
                        {friends.map((a) => (
                            <ModalRow
                                key={a.user_id}
                                handle={a.handle}
                                display_name={a.display_name}
                                avatar_url={a.avatar_url}
                                action={
                                    <span className="text-[10px] uppercase tracking-wide text-blue-700 px-2 py-0.5 border border-blue-100 bg-blue-50">
                                        Friend ✓
                                    </span>
                                }
                            />
                        ))}
                    </ModalSection>

                    <ModalSection
                        label="· Friends of friends"
                        count={fofs.length}
                        emptyCopy="No friends of friends going yet."
                    >
                        {fofs.map((a) => (
                            <ModalRow
                                key={a.user_id}
                                handle={a.handle}
                                display_name={a.display_name}
                                avatar_url={a.avatar_url}
                                subline={
                                    a.via_friend_handle ? (
                                        <>
                                            via{' '}
                                            <Link
                                                to={`/u/${a.via_friend_handle}`}
                                                className="hover:underline"
                                                onClick={onClose}
                                            >
                                                @{a.via_friend_handle}
                                            </Link>
                                        </>
                                    ) : null
                                }
                                action={<FollowChipButton handle={a.handle} variant="text" initialStatus={a.viewer_follow_status} />}
                            />
                        ))}
                    </ModalSection>

                    <ModalSection
                        label="· Also going"
                        count={others.length}
                        emptyCopy="No other public attendees yet."
                    >
                        {others.map((a) => {
                            const isSelf = a.user_id === selfUserId;
                            return (
                                <ModalRow
                                    key={a.user_id}
                                    handle={a.handle}
                                    display_name={a.display_name}
                                    avatar_url={a.avatar_url}
                                    action={
                                        isSelf ? (
                                            <span className="text-[11px] text-slate-500">(you)</span>
                                        ) : (
                                            <FollowChipButton handle={a.handle} variant="text" initialStatus={a.viewer_follow_status} />
                                        )
                                    }
                                />
                            );
                        })}
                        {anonymousTail > 0 && (
                            <li className="px-3 py-2 text-[11px] text-slate-500">
                                +{anonymousTail} anonymous public going
                            </li>
                        )}
                    </ModalSection>
                </div>
            </div>
        </div>,
        document.body,
    );
}

function ModalSection({
    label,
    count,
    emptyCopy,
    children,
}: {
    label: string;
    count: number;
    emptyCopy: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-100 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {label} ({count})
            </div>
            {count === 0 ? (
                <div className="px-3 py-2 text-[11px] text-slate-400">
                    {emptyCopy}
                </div>
            ) : (
                <ul className="divide-y divide-slate-100">{children}</ul>
            )}
        </div>
    );
}

function ModalRow({
    handle,
    display_name,
    avatar_url,
    subline,
    action,
}: {
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
    subline?: React.ReactNode;
    action: React.ReactNode;
}) {
    return (
        <li className="flex items-center gap-2 px-3 py-2">
            <Avatar
                handle={handle}
                display_name={display_name}
                avatar_url={avatar_url}
                size="sm"
            />
            <div className="min-w-0 flex-1">
                <div className="text-xs text-slate-800 truncate">
                    <NameLink
                        handle={handle}
                        display_name={display_name}
                    />
                    {handle && (
                        <span className="text-[10px] text-slate-400 ml-1">
                            @{handle}
                        </span>
                    )}
                </div>
                {subline && (
                    <div className="text-[10px] text-slate-500 mt-0.5">
                        {subline}
                    </div>
                )}
            </div>
            <div className="shrink-0">{action}</div>
        </li>
    );
}
