/**
 * Shared "is this event trending" predicate. Trending status is a
 * top-K decoration over the currently visible list, where K is the
 * effective cap:
 *   min(topN, ceil(positiveVisibleCount * topPercent / 100))
 * The underlying `popularity_score` itself stays hidden — it's an
 * internal blend (going + saved + tiny view term, decayed by age),
 * not a user-facing count. Used by both `PopularityBadge`
 * (EventListPanel) and the For You rail's card trending badge so the
 * two surfaces agree on what counts as "trending".
 */
export function isTrendingScore(
    score: number,
    allScores: number[],
    threshold: number,
    topN: number,
    topPercent: number,
): boolean {
    if (score <= 0 || score < threshold) return false;
    const sorted = [...allScores].sort((a, b) => b - a);
    const positiveCount = sorted.filter((s) => s > 0).length;
    const effectiveCap = Math.max(
        1,
        Math.min(topN, Math.ceil((positiveCount * topPercent) / 100)),
    );
    const isTopK = sorted.indexOf(score) < effectiveCap && sorted[0] > 0;
    return isTopK;
}
