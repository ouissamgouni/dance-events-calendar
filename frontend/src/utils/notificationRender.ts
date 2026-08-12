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
        case 'promo_code_approved':
            return 'approved your promo code for';
        case 'promo_code_rejected':
            return 'rejected your promo code for';
        case 'organizer_claim_decided':
            return 'reviewed your organizer claim';
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
            return '/mine/passport';
        case 'subscription_milestone':
        case 'new_follower':
        case 'new_friend':
        case 'follow_request':
        case 'follow_request_approved':
            return `/u/${item.actor.handle}`;
        case 'organizer_claim_decided':
            return '/account';
        case 'event_review_prompt':
            return `/event/${item.event_id}/review`;
        case 'event_reminder':
            return item.context === 'ask'
                ? `/event/${item.event_id}/ask`
                : `/event/${item.event_id}`;
        case 'event_message':
        case 'event_message_reply':
        case 'event_message_reported':
            return `/event/${item.event_id}#messages`;
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
