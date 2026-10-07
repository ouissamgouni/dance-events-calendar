import type { NotificationItem } from '../api';

/** Kinds that describe an actor/system action with no associated event to
 *  append after the verb (follow-graph events + milestone achievements). */
const NO_EVENT_SUFFIX_KINDS = new Set<NotificationItem['kind']>([
    'new_follower',
    'new_friend',
    'follow_request',
    'follow_request_approved',
    'subscription_milestone',
    'milestone_unlocked',
]);

/** True when the generic row should append the event title after the verb. */
export function hasEventSuffix(item: NotificationItem): boolean {
    return !NO_EVENT_SUFFIX_KINDS.has(item.kind);
}

/** Unified verb copy for the generic notification row. Superset of the
 *  branches previously duplicated across the panel and the page. */
export function getNotificationVerb(item: NotificationItem): string {
    switch (item.kind) {
        case 'subscription_going':
            return item.also_going ? 'are going to' : 'is going to';
        case 'subscription_saved':
            return 'is interested in';
        case 'plan_session_added':
            return `added ${item.context || 'a session'} to their plan for`;
        case 'subscription_review':
            return 'reviewed';
        case 'subscription_milestone':
            return item.context
                ? `reached a milestone: ${item.context}`
                : 'reached a new milestone';
        case 'subscription_suggested':
            return 'added';
        case 'new_follower':
            return 'started following you';
        case 'new_friend':
            return 'and you are now friends!';
        case 'follow_request':
            return 'wants to follow you';
        case 'follow_request_approved':
            return 'approved your follow request';
        case 'event_message':
            switch (item.context) {
                case 'question':
                    return 'asked a question about';
                case 'accommodation':
                case 'roommate': // legacy alias
                    return 'posted about accommodation for';
                case 'ride':
                    return 'posted about a ride for';
                case 'tickets':
                    return 'posted about tickets for';
                case 'meetup':
                    return 'posted a meetup for';
                case 'lost_found':
                    return 'posted a lost-and-found note for';
                default:
                    return 'posted a message on';
            }
        case 'event_message_reply':
            return item.context === 'root'
                ? 'replied to your message on'
                : 'replied to a message on';
        case 'event_message_reported':
            return 'reported a message on';
        case 'planned_session_changed':
            return 'updated your planned session for';
        case 'event_changed':
            return 'updated';
        case 'suggestion_approved':
            return 'approved your submitted event';
        case 'suggestion_declined':
            return 'kept your event private';
        case 'suggestion_rejected':
            return 'removed your event';
        case 'suggestion_change_applied':
            return 'applied your edit to';
        case 'suggestion_change_discarded':
            return 'did not accept your edit to';
        case 'event_change_applied':
            return 'applied your suggested change to';
        case 'event_change_declined':
            return 'did not apply your suggested change to';
        case 'event_change_reverted':
            return 'reverted your change to';
        case 'event_removed':
            return 'removed';
        case 'event_cancelled':
            return 'cancelled';
        case 'organizer_assigned':
            return 'made you the organizer of';
        default:
            return 'updated';
    }
}

/** Single source of truth for where a notification row navigates on click.
 *  Kinds without an event (milestones, follow-graph, organizer claim) must
 *  never fall through to `/event/${event_id}` — that yields `/event/null`. */
export function resolveNotificationDestination(item: NotificationItem): string {
    switch (item.kind) {
        case 'milestone_unlocked':
            return '/passport';
        case 'subscription_milestone':
        case 'new_follower':
        case 'new_friend':
        case 'follow_request':
        case 'follow_request_approved':
            return `/u/${item.actor.handle}`;
        case 'organizer_claim_decided':
            return '/account#organizer';
        case 'event_review_prompt':
            return `/event/${item.event_id}/review`;
        case 'event_ticket_prompt':
            return `/event/${item.event_id}/ticket`;
        case 'event_memories_prompt':
            return `/event/${item.event_id}/memories`;
        case 'event_reminder':
            return item.context === 'ask'
                ? `/event/${item.event_id}/ask`
                : `/event/${item.event_id}`;
        case 'event_message':
        case 'event_message_reply':
        case 'event_message_reported':
            return `/event/${item.event_id}#messages`;
        case 'planned_session_changed':
            return `/event/${item.event_id}/program/plan${item.schedule_session_id ? `?session=${item.schedule_session_id}` : ''}`;
        case 'event_changed':
        case 'suggestion_approved':
        case 'suggestion_declined':
        case 'suggestion_change_applied':
            return item.event_id ? `/event/${item.event_id}` : '/me/submissions';
        case 'suggestion_rejected':
        case 'suggestion_change_discarded':
            return '/me/submissions';
        case 'event_change_applied':
        case 'event_change_declined':
        case 'event_change_reverted':
            return item.event_id ? `/event/${item.event_id}` : '/me/submissions';
        case 'event_removed':
            return item.event_id ? `/event/${item.event_id}` : '/browse';
        case 'event_cancelled':
            return `/event/${item.event_id}`;
        case 'organizer_assigned':
            return item.event_id ? `/event/${item.event_id}` : '/hosting';
        case 'plan_session_added':
            return `/event/${item.event_id}/program${item.schedule_session_id ? `?session=${item.schedule_session_id}` : ''}`;
        case 'schedule_program_available':
        case 'schedule_program_updated':
            return `/event/${item.event_id}/program`;
        case 'interest_event':
            return (item.matched_event_count ?? 1) > 1
                ? `/notifications?kind=interest_event${item.matched_day ? `&day=${item.matched_day}` : ''}`
                : `/event/${item.event_id}`;
        default:
            return `/event/${item.event_id}`;
    }
}

/** Compact relative-time label (e.g. "just now", "3m ago", "2d ago"). */
export function formatRelative(iso: string): string {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diffSec = Math.max(0, Math.round((now - then) / 1000));
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
}

/** Activity-feed filter categories shown as pills. Must mirror
 *  CATEGORY_KINDS in backend/api/routes/notifications.py. */
export type NotificationCategory =
    | 'plans'
    | 'matches'
    | 'people'
    | 'reviews'
    | 'milestones'
    | 'others';

const CATEGORY_BY_KIND: Record<NotificationItem['kind'], NotificationCategory> = {
    subscription_going: 'people',
    subscription_saved: 'people',
    subscription_suggested: 'people',
    interest_event: 'matches',
    event_reminder: 'plans',
    new_follower: 'people',
    new_friend: 'people',
    follow_request: 'people',
    follow_request_approved: 'people',
    subscription_review: 'reviews',
    event_review_prompt: 'reviews',
    event_ticket_prompt: 'plans',
    event_memories_prompt: 'reviews',
    subscription_milestone: 'milestones',
    milestone_unlocked: 'milestones',
    promo_code_approved: 'others',
    promo_code_rejected: 'others',
    promo_code_added: 'others',
    organizer_claim_decided: 'others',
    event_message: 'plans',
    event_message_reply: 'plans',
    event_message_reported: 'others',
    planned_session_changed: 'plans',
    event_changed: 'plans',
    suggestion_approved: 'others',
    suggestion_declined: 'others',
    suggestion_rejected: 'others',
    suggestion_change_applied: 'others',
    suggestion_change_discarded: 'others',
    event_change_applied: 'others',
    event_change_declined: 'others',
    event_change_reverted: 'others',
    event_removed: 'plans',
    event_cancelled: 'plans',
    organizer_assigned: 'others',
    plan_session_added: 'people',
    schedule_program_available: 'plans',
    schedule_program_updated: 'plans',
};

/** Which filter-pill category a notification kind belongs to. */
export function notificationCategory(
    kind: NotificationItem['kind'],
): NotificationCategory {
    return CATEGORY_BY_KIND[kind] ?? 'others';
}

export function isNotificationKind(value: string): value is NotificationItem['kind'] {
    return Object.prototype.hasOwnProperty.call(CATEGORY_BY_KIND, value);
}
