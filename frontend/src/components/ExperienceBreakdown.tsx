import type { EventRatingAggregate } from '../types';
import { useRef, type ReactNode } from 'react';
import { SENTIMENTS } from '../utils/reviewSentiment';
import { useScrollDots } from '../hooks/useScrollDots';
import ExperienceMoodBox from './ExperienceMoodBox';
import ScrollDotsIndicator from './ScrollDots';

/** Map a 1–5 aspect average to the matching mood (Amazing→5 … Bad→1). */
export const aspectMood = (avg: number) => SENTIMENTS[Math.min(4, Math.max(0, 5 - Math.round(avg)))];

interface Props {
    aggregate: EventRatingAggregate;
    /** Human labels for aspect slugs (from the aspect tag groups). */
    aspectLabels?: Record<string, string>;
    /** When set (series roll-up), the headline reads "Based on N editions · M
     * reviews" instead of just the review count. */
    editionCount?: number;
    /** Optional content rendered directly under the "Show mood breakdown"
     * toggle (e.g. an edition's "Typical experience" card). */
    slotAfterMoodBreakdown?: ReactNode;
    /** When provided, replaces the default overall-mood headline (e.g. an
     * upcoming edition shows the series' "Typical experience" box instead of
     * presenting the pooled mood as if it were this edition's own). */
    moodHeadline?: ReactNode;
}

function ReviewRail({ title, itemCount, children }: { title: string; itemCount: number; children: ReactNode }) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(scrollerRef, [itemCount]);

    return (
        <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft mb-1.5">{title}</div>
            <div ref={scrollerRef} className="flex gap-1.5 overflow-x-auto pb-1">
                {children}
            </div>
            <ScrollDotsIndicator
                count={dotCount}
                activeIndex={activeIndex}
                onSelect={scrollToIndex}
                label={`${title} scroll position`}
            />
        </div>
    );
}

/**
 * Public "Community Experience" breakdown. Leads with an overall-mood headline
 * (label + "X% rated it Great or Amazing" + review count), then the community
 * summary (People appreciated / Good to know / Best suited for) and a per-aspect
 * "Ratings by area" breakdown last. The numeric mood distribution collapses
 * behind a `<details>`. Renders nothing when there is no structured data yet.
 */
export default function ExperienceBreakdown({ aggregate, aspectLabels = {}, editionCount, slotAfterMoodBreakdown, moodHeadline }: Props) {
    const sentimentTotal = Object.values(aggregate.sentiment_distribution).reduce(
        (a, b) => a + (b ?? 0),
        0,
    );
    const aspects = aggregate.aspects ?? [];
    const appreciated = aggregate.top_positive_tags ?? [];
    const mentioned = [
        ...(aggregate.top_neutral_tags ?? []).map((tag, index) => ({ tag, negative: false, index })),
        ...(aggregate.top_negative_tags ?? []).map((tag, index) => ({ tag, negative: true, index })),
    ].sort((a, b) => b.tag.count - a.tag.count || Number(a.negative) - Number(b.negative) || a.index - b.index);
    const recommendedFor = aggregate.top_audience_tags ?? [];

    if (
        !sentimentTotal &&
        aspects.length === 0 &&
        appreciated.length === 0 &&
        mentioned.length === 0 &&
        recommendedFor.length === 0
    ) {
        return null;
    }

    const aspectLabel = (slug: string) =>
        aspectLabels[slug] ?? slug.replace(/(^|[-_])(\w)/g, (_, __, c) => ` ${c.toUpperCase()}`).trim();

    return (
        <div className="space-y-4">
            {/* Overall-mood headline: icon + label + percentage on one line.
                An upcoming edition passes its series' "Typical experience" box as
                `moodHeadline` to replace this, since the pooled mood isn't this
                specific edition's own. */}
            {moodHeadline !== undefined ? (
                moodHeadline
            ) : (
                <ExperienceMoodBox
                    label="Overall experience"
                    displayState={aggregate.display_state}
                    emoji={aspectMood(aggregate.average_mood).emoji}
                    moodLabel={aggregate.mood_label}
                    positivePercentage={aggregate.positive_percentage ?? 0}
                    subline={editionCount != null
                        ? `Based on ${editionCount} edition${editionCount === 1 ? '' : 's'} · ${aggregate.count} review${aggregate.count === 1 ? '' : 's'}`
                        : `Based on ${aggregate.count} review${aggregate.count === 1 ? '' : 's'}`}
                />
            )}

            {/* Numeric mood breakdown — collapsed by default, directly under the headline */}
            {sentimentTotal > 0 && (
                <details className="text-xs">
                    <summary className="cursor-pointer text-[9px] font-semibold uppercase tracking-wide text-ink-soft select-none">
                        Show mood breakdown
                    </summary>
                    <div className="space-y-1 mt-1.5">
                        {SENTIMENTS.map((s) => {
                            const count = aggregate.sentiment_distribution[s.value] ?? 0;
                            const pct = sentimentTotal > 0 ? Math.round((count / sentimentTotal) * 100) : 0;
                            return (
                                <div key={s.value} className="flex items-center gap-2 text-xs">
                                    <span className="w-28 shrink-0 text-ink-soft">{s.emoji} {s.label}</span>
                                    <div className="flex-1 h-2 bg-slate-200 overflow-hidden">
                                        <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
                                    </div>
                                    <span className="w-8 text-right text-ink-soft tabular-nums">{count}</span>
                                </div>
                            );
                        })}
                    </div>
                </details>
            )}

            {slotAfterMoodBreakdown}

            {/* Community summary — each group on one horizontally scrollable line */}
            {(appreciated.length > 0 || mentioned.length > 0 || recommendedFor.length > 0) && (
                <div className="space-y-3 border-t border-card-line pt-4">
                    {appreciated.length > 0 && (
                        <ReviewRail title="People appreciated" itemCount={appreciated.length}>
                            {appreciated.map((t) => (
                                <span key={t.tag_id} className="shrink-0 whitespace-nowrap rounded-full bg-green-50 text-success px-2 py-0.5 text-[11px]">
                                    {t.label} ({t.count})
                                </span>
                            ))}
                        </ReviewRail>
                    )}
                    {mentioned.length > 0 && (
                        <ReviewRail title="People mentioned" itemCount={mentioned.length}>
                            {mentioned.map(({ tag, negative }) => (
                                <span
                                    key={tag.tag_id}
                                    className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${negative ? 'bg-orange-50 text-orange-800' : 'bg-slate-100 text-ink-soft'}`}
                                >
                                    {tag.label} ({tag.count})
                                </span>
                            ))}
                        </ReviewRail>
                    )}
                    {recommendedFor.length > 0 && (
                        <ReviewRail title="Best suited for" itemCount={recommendedFor.length}>
                            {recommendedFor.map((t) => (
                                <span key={t.tag_id} className="shrink-0 whitespace-nowrap rounded-full bg-slate-100 text-ink-soft px-2 py-0.5 text-[11px]">
                                    {t.label} ({t.count})
                                </span>
                            ))}
                        </ReviewRail>
                    )}
                </div>
            )}

            {/* By aspect — one horizontally scrollable line of badges */}
            {aspects.length > 0 && (
                <div className="border-t border-card-line pt-4">
                    <ReviewRail title="Ratings by area" itemCount={aspects.length}>
                        {aspects.map((a) => {
                            const m = aspectMood(a.average);
                            return (
                                <span
                                    key={a.aspect_slug}
                                    className="shrink-0 whitespace-nowrap rounded-full bg-slate-100 text-ink px-2 py-0.5 text-[11px]"
                                >
                                    {aspectLabel(a.aspect_slug)} {m.emoji} {m.label} ({a.count})
                                </span>
                            );
                        })}
                    </ReviewRail>
                </div>
            )}
        </div>
    );
}
