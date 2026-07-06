/**
 * Compact "in X days/weeks/months" countdown label for event rail cards.
 * `compact=true` returns the mobile short form ("in 3d", "in 2w", "in 1m").
 * Returns "today" / "tomorrow" for 0 / 1 days ahead, and null for events
 * that already started (negative delta).
 */
export function formatCountdown(startIso: string, now: Date = new Date(), compact = false): string | null {
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) return null;

    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msPerDay = 86_400_000;
    const days = Math.round((startDay.getTime() - nowDay.getTime()) / msPerDay);

    if (days < 0) return null;
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';

    if (days < 7) return compact ? `in ${days}d` : `in ${days} day${days === 1 ? '' : 's'}`;
    if (days < 60) {
        const weeks = Math.round(days / 7);
        return compact ? `in ${weeks}w` : `in ${weeks} week${weeks === 1 ? '' : 's'}`;
    }
    const months = Math.round(days / 30);
    return compact ? `in ${months}m` : `in ${months} month${months === 1 ? '' : 's'}`;
}
