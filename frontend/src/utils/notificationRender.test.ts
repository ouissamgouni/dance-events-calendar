import { describe, it, expect } from 'vitest';
import type { NotificationItem } from '../api';
import {
    getNotificationVerb,
    notificationCategory,
    resolveNotificationDestination,
} from './notificationRender';

/** Minimal NotificationItem factory — only the fields the pure render
 *  helpers read are set; the rest are cast away for brevity. */
function item(overrides: Partial<NotificationItem>): NotificationItem {
    return {
        kind: 'event_message',
        event_id: 'evt-1',
        context: null,
        created_at: '2099-01-01T00:00:00Z',
        ...overrides,
    } as NotificationItem;
}

describe('getNotificationVerb — reply copy personalization', () => {
    it('uses "your message" copy for the root author (context="root")', () => {
        const verb = getNotificationVerb(item({ kind: 'event_message_reply', context: 'root' }));
        expect(verb).toBe('replied to your message on');
    });

    it('uses generic copy for other thread participants', () => {
        const verb = getNotificationVerb(item({ kind: 'event_message_reply', context: 'ride' }));
        expect(verb).toBe('replied to a message on');
    });
});

describe('resolveNotificationDestination — reminder ask deep-link', () => {
    it('routes an "ask" reminder to the /ask deep link', () => {
        const dest = resolveNotificationDestination(
            item({ kind: 'event_reminder', context: 'ask' }),
        );
        expect(dest).toBe('/event/evt-1/ask');
    });

    it('routes a plain reminder to the event page', () => {
        const dest = resolveNotificationDestination(
            item({ kind: 'event_reminder', context: null }),
        );
        expect(dest).toBe('/event/evt-1');
    });

    it('routes event messages to the #messages board', () => {
        const dest = resolveNotificationDestination(item({ kind: 'event_message' }));
        expect(dest).toBe('/event/evt-1#messages');
    });

    it('routes a Program announcement directly to the Program', () => {
        expect(resolveNotificationDestination(item({ kind: 'schedule_program_available' }))).toBe(
            '/event/evt-1/program',
        );
    });

    it('routes submitter notifications without yielding /event/null', () => {
        expect(resolveNotificationDestination(item({ kind: 'event_changed' }))).toBe('/event/evt-1');
        expect(resolveNotificationDestination(item({ kind: 'suggestion_approved' }))).toBe('/event/evt-1');
        expect(resolveNotificationDestination(item({ kind: 'suggestion_change_applied' }))).toBe('/event/evt-1');
        expect(resolveNotificationDestination(item({ kind: 'suggestion_rejected', event_id: null }))).toBe('/me/submissions');
        // A declined event is still the owner's, so it opens the event itself.
        expect(resolveNotificationDestination(item({ kind: 'suggestion_declined', event_id: 'suggestion-1' }))).toBe('/event/suggestion-1');
        expect(resolveNotificationDestination(item({ kind: 'suggestion_change_discarded', event_id: null }))).toBe('/me/submissions');
        expect(resolveNotificationDestination(item({ kind: 'suggestion_change_discarded' }))).toBe('/me/submissions');
    });

    it('routes removed events to the kept duplicate, else to browsing', () => {
        expect(resolveNotificationDestination(item({ kind: 'event_removed', event_id: 'evt-kept' }))).toBe('/event/evt-kept');
        expect(resolveNotificationDestination(item({ kind: 'event_removed', event_id: null }))).toBe('/browse');
        expect(resolveNotificationDestination(item({ kind: 'event_change_applied' }))).toBe('/event/evt-1');
    });

    it('routes organizer assignments to the event, or to Hosting for several', () => {
        expect(resolveNotificationDestination(item({ kind: 'organizer_assigned' }))).toBe('/event/evt-1');
        expect(resolveNotificationDestination(item({ kind: 'organizer_assigned', event_id: null }))).toBe('/hosting');
        expect(resolveNotificationDestination(item({ kind: 'event_cancelled' }))).toBe('/event/evt-1');
    });
});

describe('subscription_saved', () => {
    it('reads as "is interested in"', () => {
        expect(getNotificationVerb(item({ kind: 'subscription_saved' }))).toBe('is interested in');
    });

    it('routes to the event page', () => {
        expect(resolveNotificationDestination(item({ kind: 'subscription_saved' }))).toBe(
            '/event/evt-1',
        );
    });
});

describe('notificationCategory', () => {
    it('maps own-plan kinds to "plans"', () => {
        expect(notificationCategory('event_reminder')).toBe('plans');
        expect(notificationCategory('schedule_program_available')).toBe('plans');
        expect(notificationCategory('planned_session_changed')).toBe('plans');
        expect(notificationCategory('event_changed')).toBe('plans');
        expect(notificationCategory('event_message')).toBe('plans');
        expect(notificationCategory('event_message_reply')).toBe('plans');
        expect(notificationCategory('event_message_reported')).toBe('others');
    });

    it('maps interest matches to "matches"', () => {
        expect(notificationCategory('interest_event')).toBe('matches');
    });

    it('maps follow and followee activity kinds to "people"', () => {
        expect(notificationCategory('subscription_going')).toBe('people');
        expect(notificationCategory('subscription_saved')).toBe('people');
        expect(notificationCategory('plan_session_added')).toBe('people');
        expect(notificationCategory('new_follower')).toBe('people');
        expect(notificationCategory('new_friend')).toBe('people');
        expect(notificationCategory('follow_request')).toBe('people');
    });

    it('maps review kinds to "reviews"', () => {
        expect(notificationCategory('subscription_review')).toBe('reviews');
        expect(notificationCategory('event_review_prompt')).toBe('reviews');
        expect(notificationCategory('event_memories_prompt')).toBe('reviews');
    });

    it('routes ticket and memories nudges to their deep links', () => {
        expect(notificationCategory('event_ticket_prompt')).toBe('plans');
        expect(resolveNotificationDestination(item({ kind: 'event_ticket_prompt' }))).toBe('/event/evt-1/ticket');
        expect(resolveNotificationDestination(item({ kind: 'event_memories_prompt' }))).toBe('/event/evt-1/memories');
    });

    it('maps milestone kinds to "milestones"', () => {
        expect(notificationCategory('subscription_milestone')).toBe('milestones');
        expect(notificationCategory('milestone_unlocked')).toBe('milestones');
    });

    it('maps promo/claim kinds to "others"', () => {
        expect(notificationCategory('promo_code_added')).toBe('others');
        expect(notificationCategory('organizer_claim_decided')).toBe('others');
        expect(notificationCategory('suggestion_approved')).toBe('others');
        expect(notificationCategory('suggestion_rejected')).toBe('others');
        expect(notificationCategory('suggestion_change_applied')).toBe('others');
        expect(notificationCategory('suggestion_change_discarded')).toBe('others');
    });
});
