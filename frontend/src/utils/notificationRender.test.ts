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
    it('maps event kinds to "events"', () => {
        expect(notificationCategory('subscription_going')).toBe('events');
        expect(notificationCategory('subscription_saved')).toBe('events');
        expect(notificationCategory('event_reminder')).toBe('events');
    });

    it('maps follow/friend kinds to "network"', () => {
        expect(notificationCategory('new_follower')).toBe('network');
        expect(notificationCategory('new_friend')).toBe('network');
        expect(notificationCategory('follow_request')).toBe('network');
    });

    it('maps review kinds to "reviews"', () => {
        expect(notificationCategory('subscription_review')).toBe('reviews');
        expect(notificationCategory('event_review_prompt')).toBe('reviews');
    });

    it('maps milestone kinds to "milestones"', () => {
        expect(notificationCategory('subscription_milestone')).toBe('milestones');
        expect(notificationCategory('milestone_unlocked')).toBe('milestones');
    });

    it('maps promo/claim kinds to "others"', () => {
        expect(notificationCategory('promo_code_added')).toBe('others');
        expect(notificationCategory('organizer_claim_decided')).toBe('others');
    });
});
