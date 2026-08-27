import { useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Bell,
    Bookmark,
    CalendarCheck,
    CalendarPlus,
    Clock,
    Flag,
    type LucideIcon,
    MessageCircle,
    Sparkles,
    SquarePen,
    Star,
    Tag,
    Trophy,
    UserPlus,
    Users,
} from 'lucide-react';
import {
    approveFollowRequest,
    declineFollowRequest,
    followUser,
    type NotificationActor,
    type NotificationItem,
} from '../api';
import {
    formatRelative,
    getNotificationVerb,
    hasEventSuffix,
    resolveNotificationDestination,
} from '../utils/notificationRender';

type Variant = 'page' | 'panel';

/** Per-kind tinted type icon shown at the far left of every row. Soft
 *  circular backgrounds, never saturated blocks. */
const TYPE_ICON: Record<NotificationItem['kind'], { Icon: LucideIcon; cls: string }> = {
    subscription_going: { Icon: CalendarCheck, cls: 'bg-violet-100 text-violet-600' },
    subscription_saved: { Icon: Bookmark, cls: 'bg-blue-100 text-action' },
    subscription_suggested: { Icon: CalendarPlus, cls: 'bg-emerald-100 text-emerald-600' },
    subscription_review: { Icon: SquarePen, cls: 'bg-violet-100 text-violet-600' },
    subscription_milestone: { Icon: Trophy, cls: 'bg-amber-100 text-amber-600' },
    milestone_unlocked: { Icon: Trophy, cls: 'bg-amber-100 text-amber-600' },
    new_follower: { Icon: UserPlus, cls: 'bg-blue-100 text-action' },
    follow_request: { Icon: UserPlus, cls: 'bg-blue-100 text-action' },
    follow_request_approved: { Icon: UserPlus, cls: 'bg-blue-100 text-action' },
    new_friend: { Icon: Users, cls: 'bg-emerald-100 text-emerald-600' },
    event_reminder: { Icon: Clock, cls: 'bg-rose-100 text-rose-600' },
    event_review_prompt: { Icon: Star, cls: 'bg-violet-100 text-violet-600' },
    interest_event: { Icon: Sparkles, cls: 'bg-blue-100 text-action' },
    promo_code_added: { Icon: Tag, cls: 'bg-amber-100 text-amber-600' },
    promo_code_approved: { Icon: Tag, cls: 'bg-amber-100 text-amber-600' },
    promo_code_rejected: { Icon: Tag, cls: 'bg-amber-100 text-amber-600' },
    organizer_claim_decided: { Icon: Bell, cls: 'bg-slate-100 text-ink-soft' },
    event_message: { Icon: MessageCircle, cls: 'bg-sky-100 text-sky-600' },
    event_message_reply: { Icon: MessageCircle, cls: 'bg-sky-100 text-sky-600' },
    event_message_reported: { Icon: Flag, cls: 'bg-sky-100 text-sky-600' },
};

/** Kinds that carry a real person and render an avatar next to the type icon.
 *  System kinds (reminders, promos, event messages, personal milestone) show
 *  the tinted type icon only. */
const AVATAR_KINDS = new Set<NotificationItem['kind']>([
    'subscription_going',
    'subscription_saved',
    'subscription_suggested',
    'subscription_review',
    'subscription_milestone',
    'new_follower',
    'new_friend',
    'follow_request',
    'follow_request_approved',
]);

const displayNameOf = (a: NotificationActor): string =>
    a.display_name || (a.handle ? `@${a.handle}` : 'Someone');

/** "Emma", "Emma and Samir", or "Emma, Samir +9 others". */
function formatActorNames(actors: NotificationActor[], total: number): string {
    const names = actors.map(displayNameOf);
    if (total <= 1) return names[0] ?? 'Someone';
    if (total === 2) return `${names[0]} and ${names[1]}`;
    const shown = names.slice(0, 2);
    return `${shown.join(', ')} +${total - shown.length} others`;
}

/** Plural verb for aggregated multi-actor event rows. */
function groupVerb(item: NotificationItem): string {
    switch (item.kind) {
        case 'subscription_going':
            return 'are going to';
        case 'subscription_saved':
            return 'are interested in';
        case 'subscription_suggested':
            return 'added';
        case 'subscription_review':
            return 'reviewed';
        default:
            return getNotificationVerb(item);
    }
}


/**
 * Single source of truth for rendering one notification.
 *
 * Both the full-page feed (`/notifications`, `/tribe/activity`) and the bell
 * dropdown panel render rows through this component so new kinds, pills, and
 * copy stay in sync. `variant` only drives layout/sizing differences:
 *   - `page`: row is a flex `<li>` with a trailing "Mark read" control; the
 *     component owns navigation (marks read, then routes).
 *   - `panel`: the whole row is one clickable `<button>` (`onClick`) with a
 *     compact unread dot; navigation is delegated to the caller.
 */
export default function NotificationRow({
    item,
    variant,
    busy = false,
    onMarkRead,
    onClick,
    onFollowedBack,
}: {
    item: NotificationItem;
    variant: Variant;
    busy?: boolean;
    onMarkRead?: () => void;
    onClick?: () => void;
    onFollowedBack?: (handle: string) => void;
}) {
    const navigate = useNavigate();
    const isPanel = variant === 'panel';
    const isUnread = !item.read_at;
    const destination = resolveNotificationDestination(item);

    const [requestHandled, setRequestHandled] = useState<'approved' | 'declined' | null>(null);
    const [requestBusy, setRequestBusy] = useState(false);
    const [following, setFollowing] = useState<boolean>(Boolean(item.actor.is_following));
    const [followBusy, setFollowBusy] = useState(false);

    const handleNavigate = () => {
        if (isPanel) {
            onClick?.();
            return;
        }
        if (isUnread) onMarkRead?.();
        navigate(destination);
    };

    const handleApprove = async (e: MouseEvent) => {
        e.stopPropagation();
        if (requestBusy) return;
        setRequestBusy(true);
        try {
            await approveFollowRequest(item.actor.handle);
            setRequestHandled('approved');
            window.dispatchEvent(new Event('network:changed'));
        } finally {
            setRequestBusy(false);
        }
    };
    const handleDecline = async (e: MouseEvent) => {
        e.stopPropagation();
        if (requestBusy) return;
        setRequestBusy(true);
        try {
            await declineFollowRequest(item.actor.handle);
            setRequestHandled('declined');
            window.dispatchEvent(new Event('network:changed'));
        } finally {
            setRequestBusy(false);
        }
    };
    const handleFollowBack = async (e: MouseEvent) => {
        e.stopPropagation();
        if (followBusy || following) return;
        setFollowBusy(true);
        // Optimistic flip — keep the row visible so the pill swap is observable.
        setFollowing(true);
        try {
            await followUser(item.actor.handle);
            onFollowedBack?.(item.actor.handle);
        } catch {
            setFollowing(false);
        } finally {
            setFollowBusy(false);
        }
    };

    const verb = getNotificationVerb(item);
    const isAnonReview = item.kind === 'subscription_review' && item.context === 'anon';
    const actorName = isAnonReview
        ? 'Someone'
        : item.actor.display_name || `@${item.actor.handle}`;
    const noEventSuffix = !hasEventSuffix(item);

    // Variant style tokens.
    const mainCls = isPanel
        ? 'text-sm leading-snug text-ink'
        : 'text-[15px] leading-snug text-ink';
    const timeClass = isPanel
        ? 'text-[11px] text-muted mt-0.5'
        : 'text-[13px] text-muted mt-0.5';
    const specialTitle = mainCls;
    const subLabelSize = isPanel ? 'text-[11px]' : 'text-[13px]';
    const descClass = isPanel
        ? 'text-[11px] text-ink-soft mt-0.5'
        : 'text-[13px] text-ink-soft mt-0.5';

    const avatarSize = isPanel ? 'w-8 h-8' : 'w-10 h-10';
    const { Icon: TypeGlyph, cls: typeCls } = TYPE_ICON[item.kind] ?? {
        Icon: Bell,
        cls: 'bg-slate-100 text-ink-soft',
    };
    const typeIcon = (
        <div
            // eslint-disable-next-line no-restricted-syntax -- circular tinted type badge (allowed exception per frontend rules)
            className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${typeCls}`}
            aria-hidden="true"
        >
            <TypeGlyph size={18} strokeWidth={2} />
        </div>
    );

    const avatarEl = (a: NotificationActor, size: string): ReactNode =>
        a.avatar_url ? (
            <img
                src={a.avatar_url}
                alt=""
                // eslint-disable-next-line no-restricted-syntax -- avatar (allowed exception per frontend rules)
                className={`${size} rounded-full object-cover bg-slate-100 shrink-0`}
            />
        ) : (
            <div
                // eslint-disable-next-line no-restricted-syntax -- avatar placeholder (allowed exception per frontend rules)
                className={`${size} rounded-full bg-slate-200 text-ink-soft flex items-center justify-center font-semibold shrink-0 ${isPanel ? 'text-xs' : 'text-sm'}`}
            >
                {(displayNameOf(a) || '?').trim().charAt(0).toUpperCase()}
            </div>
        );

    const actorsList: NotificationActor[] =
        item.actors && item.actors.length > 0 ? item.actors : [item.actor];
    const actorCount = item.actor_count ?? actorsList.length;
    const isAvatarKind = AVATAR_KINDS.has(item.kind);
    const isMulti = isAvatarKind && actorCount > 1;

    const thumbNode: ReactNode = item.event_image_url ? (
        <img
            src={item.event_image_url}
            alt=""
            // eslint-disable-next-line no-restricted-syntax -- event thumbnail uses card radius (allowed per frontend rules)
            className="w-14 h-14 rounded-card object-cover bg-slate-100 shrink-0"
        />
    ) : null;

    const avatarStack = (
        <div className="flex items-center">
            {actorsList.slice(0, 3).map((a, i) => (
                <span key={a.handle || i} className={i > 0 ? '-ml-2' : ''}>
                    {avatarEl(a, 'w-8 h-8 ring-2 ring-surface')}
                </span>
            ))}
            {actorCount > 3 && (
                <span
                    // eslint-disable-next-line no-restricted-syntax -- avatar overflow bubble (allowed exception per frontend rules)
                    className="-ml-2 w-8 h-8 rounded-full bg-slate-100 ring-2 ring-surface text-[11px] font-semibold text-ink-soft flex items-center justify-center shrink-0"
                >
                    +{actorCount - 3}
                </span>
            )}
        </div>
    );

    const orgaBadge = item.actor.is_verified_organizer ? (
        <img
            src="/orga.png"
            alt=""
            title="Verified organizer"
            aria-label="Verified organizer"
            className="inline-block w-3.5 h-3.5 ml-1 align-middle object-contain"
        />
    ) : null;

    let body: ReactNode;

    if (item.kind === 'interest_event') {
        const label = item.context || 'your saved search';
        body = (
            <>
                <p className={specialTitle}>
                    <span className="font-medium text-ink">
                        {item.event_title || 'An event'}
                    </span>{' '}
                    <span className="text-ink-soft">matched your {label} alert</span>
                </p>
                <p className={timeClass}>
                    {formatRelative(item.created_at)}
                    {!isPanel && (
                        <>
                            {' '}·{' '}
                            <span
                                role="link"
                                tabIndex={0}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    navigate('/account#notifications');
                                }}
                                className="text-action hover:text-action"
                            >
                                Manage alerts
                            </span>
                        </>
                    )}
                </p>
            </>
        );
    } else if (item.kind === 'event_reminder') {
        const startLabel = item.event_start
            ? new Date(item.event_start).toLocaleString([], {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
            })
            : null;
        body = (
            <>
                <p className={specialTitle}>
                    <span className="text-ink-soft">Reminder — you're going to</span>{' '}
                    <span className="font-medium text-ink">
                        {item.event_title || 'an event'}
                    </span>
                </p>
                {startLabel && (
                    <p className={`${subLabelSize} text-rose-600 mt-0.5`}>Starts {startLabel}</p>
                )}
                {item.context === 'ask' && (
                    <p className={`${subLabelSize} text-action mt-0.5`}>💬 Ask a question about this event</p>
                )}
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else if (item.kind === 'promo_code_added') {
        body = (
            <>
                <p className={specialTitle}>
                    <span className="text-ink-soft">Promo code added —</span>{' '}
                    <span className="font-medium text-ink">
                        {item.event_title || 'an event'}
                    </span>
                </p>
                {item.context && (
                    <p className={`${subLabelSize} text-amber-600 mt-0.5`}>Code: {item.context}</p>
                )}
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else if (item.kind === 'event_review_prompt') {
        body = (
            <>
                <p className={specialTitle}>
                    {item.context ? (
                        <span className="text-ink-soft">
                            <span className="font-medium text-ink">{item.context}</span>{' '}
                            shared their experience at
                        </span>
                    ) : (
                        <span className="text-ink-soft">How was it? Rate your experience at</span>
                    )}{' '}
                    <span className="font-medium text-ink">
                        {item.event_title || 'an event'}
                    </span>
                </p>
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else if (item.kind === 'milestone_unlocked') {
        body = (
            <>
                <p className={specialTitle}>
                    <span className="text-ink-soft">Milestone unlocked —</span>{' '}
                    <span className="font-medium text-ink">
                        {item.context || 'a new achievement'}
                    </span>
                </p>
                {item.description && <p className={descClass}>{item.description}</p>}
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else if (
        item.kind === 'event_message' ||
        item.kind === 'event_message_reply' ||
        item.kind === 'event_message_reported'
    ) {
        body = (
            <>
                <p className={specialTitle}>
                    <span className="font-medium text-ink">{actorName}</span>{' '}
                    <span className="text-ink-soft">{verb}</span>{' '}
                    <span className="font-medium text-ink">
                        {item.event_title || 'an event'}
                    </span>
                </p>
                {item.description && <p className={descClass}>{item.description}</p>}
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    } else {
        const nameText = isMulti
            ? formatActorNames(actorsList, actorCount)
            : item.kind === 'subscription_going' && item.also_going
                ? `You and ${actorName}`
                : actorName;
        const verbText = isMulti ? groupVerb(item) : verb;
        body = (
            <>
                <p className={mainCls}>
                    <span className="font-semibold text-ink">{nameText}</span>
                    {!isMulti && orgaBadge}{' '}
                    <span className="text-ink-soft">{verbText}</span>
                    {!noEventSuffix && (
                        <>
                            {' '}
                            <span className="font-semibold text-ink">
                                {item.event_title || 'an event'}
                            </span>
                        </>
                    )}
                </p>
                <p className={timeClass}>{formatRelative(item.created_at)}</p>
            </>
        );
    }

    const avatarNode: ReactNode = !isAvatarKind
        ? null
        : isMulti
            ? avatarStack
            : avatarEl(item.actor, avatarSize);

    // Inline affordances that live in the row's trailing slot (page) or inside
    // the row button (panel).
    let actionNode: ReactNode = null;
    if (item.kind === 'new_follower') {
        actionNode = following ? (
            <span className="inline-block px-2 py-1 text-[11px] border border-line bg-surface text-ink-soft">
                ✓ Following
            </span>
        ) : (
            <button
                type="button"
                onClick={handleFollowBack}
                disabled={followBusy}
                className="px-2 py-1 text-[11px] bg-action text-white hover:bg-action disabled:opacity-60"
            >
                {followBusy ? 'Following…' : 'Follow back'}
            </button>
        );
    } else if (item.kind === 'new_friend') {
        actionNode = (
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    navigate(destination);
                }}
                className="px-2 py-1 text-[11px] border border-line bg-surface text-ink hover:bg-canvas"
            >
                View profile
            </button>
        );
    } else if (item.kind === 'follow_request') {
        actionNode =
            requestHandled === 'approved' ? (
                <span className="inline-block px-2 py-1 text-[11px] border border-line bg-surface text-ink-soft">
                    ✓ Approved
                </span>
            ) : requestHandled === 'declined' ? (
                <span className="inline-block px-2 py-1 text-[11px] border border-line bg-surface text-ink-soft">
                    Declined
                </span>
            ) : (
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={handleApprove}
                        disabled={requestBusy}
                        className="px-2 py-1 text-[11px] bg-action text-white hover:bg-action disabled:opacity-60"
                    >
                        {requestBusy ? '…' : 'Approve'}
                    </button>
                    <button
                        type="button"
                        onClick={handleDecline}
                        disabled={requestBusy}
                        className="px-2 py-1 text-[11px] border border-line bg-surface text-ink hover:bg-canvas disabled:opacity-60"
                    >
                        Decline
                    </button>
                </div>
            );
    }

    if (isPanel) {
        return (
            <li>
                <button
                    type="button"
                    onClick={handleNavigate}
                    className={`w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-canvas ${isUnread ? 'bg-blue-50/40' : 'bg-surface'}`}
                >
                    {typeIcon}
                    {avatarNode}
                    <div className="min-w-0 flex-1">
                        {body}
                        {actionNode && <div className="mt-2">{actionNode}</div>}
                    </div>
                    {thumbNode}
                    {isUnread && (
                        <span
                            // eslint-disable-next-line no-restricted-syntax -- small unread status dot (allowed exception per frontend rules)
                            className="mt-1.5 w-1.5 h-1.5 rounded-full bg-action shrink-0"
                            aria-label="Unread"
                        />
                    )}
                </button>
            </li>
        );
    }

    return (
        <li
            className={`flex items-start gap-3 px-4 py-3.5 ${isUnread ? 'bg-blue-50/40' : 'bg-surface'}`}
        >
            {typeIcon}
            {avatarNode}
            <button
                type="button"
                onClick={handleNavigate}
                className="min-w-0 flex-1 text-left"
            >
                {body}
            </button>
            {thumbNode}
            <div className="shrink-0 flex flex-col items-end gap-2">
                {actionNode}
                {isUnread && (
                    <button
                        type="button"
                        onClick={onMarkRead}
                        disabled={busy}
                        className="text-[13px] text-ink-soft hover:text-action disabled:opacity-50"
                    >
                        {busy ? '…' : 'Mark read'}
                    </button>
                )}
            </div>
        </li>
    );
}
