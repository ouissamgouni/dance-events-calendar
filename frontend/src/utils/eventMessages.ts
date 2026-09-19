import type { EventMessageCategory } from '../api';

/** Category presentation. Full literal Tailwind class strings only (the JIT
 *  scanner can't see interpolated suffixes). Shared by the message board modal,
 *  the inline section, and the compact teaser. */
export const CATEGORY_META: Record<EventMessageCategory, { label: string; emoji: string; badge: string }> = {
    question: { label: 'Question', emoji: '❓', badge: 'bg-blue-100 text-action' },
    accommodation: { label: 'Accommodation', emoji: '🛏️', badge: 'bg-purple-100 text-purple-700' },
    ride: { label: 'Ride', emoji: '🚗', badge: 'bg-emerald-100 text-success' },
    tickets: { label: 'Tickets', emoji: '🎟️', badge: 'bg-amber-100 text-amber-700' },
    meetup: { label: 'Meetup', emoji: '👋', badge: 'bg-teal-100 text-teal-700' },
    lost_found: { label: 'Lost & Found', emoji: '🔎', badge: 'bg-orange-100 text-orange-700' },
    other: { label: 'Other', emoji: '💬', badge: 'bg-slate-100 text-ink-soft' },
};

export const CATEGORY_ORDER: EventMessageCategory[] = ['question', 'accommodation', 'ride', 'tickets', 'meetup', 'lost_found', 'other'];

/** Compact relative-time label. Treats naive ISO timestamps as UTC. */
export function timeAgo(iso: string): string {
    const then = new Date(`${iso}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? '' : 'Z'}`).getTime();
    const diff = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
}
