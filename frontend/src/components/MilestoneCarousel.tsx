import { useRef } from 'react';
import { Link } from 'react-router-dom';
import type { PassportMilestone } from '../types';
import ScrollDotsIndicator from './ScrollDots';
import SectionHeading from './SectionHeading';
import { useScrollDots } from '../hooks/useScrollDots';

interface MilestoneCarouselProps {
    milestones: PassportMilestone[];
}

export default function MilestoneCarousel({ milestones }: MilestoneCarouselProps) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(scrollerRef, [milestones.length]);

    if (milestones.length === 0) return null;

    return (
        <section aria-labelledby="next-milestone-title">
            <SectionHeading
                id="next-milestone-title"
                title="Next Milestones"
                action={{ label: 'See all', to: '/mine/passport' }}
            />
            <div
                ref={scrollerRef}
                className="flex overflow-x-auto snap-x snap-mandatory gap-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                {milestones.map((m) => (
                    <Link
                        key={m.key}
                        to="/mine/passport"
                        className="w-full shrink-0 snap-start flex min-h-28 items-center gap-3 rounded-card border border-card-line bg-surface px-3 py-4 shadow-sm transition hover:border-action focus:outline-none focus:ring-2 focus:ring-action"
                    >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface/70 text-2xl" aria-hidden="true">{m.icon || '🏆'}</span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-ink">{m.name}</span>
                            <span className="mt-0.5 block text-[11px] font-semibold text-ink-soft tabular-nums">
                                {m.progress} / {m.threshold} {m.unit}
                            </span>
                            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-line">
                                <span
                                    className="block h-full rounded-full bg-brand"
                                    style={{ width: `${Math.min(100, (m.progress / m.threshold) * 100)}%` }}
                                />
                            </span>
                        </span>
                    </Link>
                ))}
            </div>
            <ScrollDotsIndicator count={dotCount} activeIndex={activeIndex} onSelect={scrollToIndex} className="mt-2" />
        </section>
    );
}
