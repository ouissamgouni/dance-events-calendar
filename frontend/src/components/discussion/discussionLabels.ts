import type { EventMessageCategory } from '../../api';
import { CATEGORY_META, CATEGORY_ORDER } from '../../utils/eventMessages';

/**
 * Discussion-surface category labels. Identical to the shared CATEGORY_META
 * except "accommodation" reads as "Stay" per the Discussion spec. Kept local so
 * the legacy message board keeps its own wording.
 */
export const DISCUSSION_LABEL: Record<EventMessageCategory, string> = {
    question: 'Question',
    accommodation: 'Stay',
    ride: 'Ride',
    tickets: 'Tickets',
    meetup: 'Meetup',
    lost_found: 'Lost & Found',
    other: 'Other',
};

export const DISCUSSION_CATEGORY_ORDER = CATEGORY_ORDER;

export function discussionMeta(category: EventMessageCategory) {
    const meta = CATEGORY_META[category] ?? CATEGORY_META.other;
    return { ...meta, label: DISCUSSION_LABEL[category] ?? meta.label };
}
