import { useRef, useState } from 'react';
import { useScrollDots } from '../hooks/useScrollDots';
import ScrollDotsIndicator from './ScrollDots';

export interface PresetSectionProps {
    title: string;
    children: React.ReactNode;
    carouselLabel?: string;
    defaultExpanded?: boolean;
}

export default function PresetSection({ title, children, carouselLabel = title, defaultExpanded = false }: PresetSectionProps) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const dots = useScrollDots(scrollerRef, [children]);
    return (
        <section className="flex flex-col gap-2">
            <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
                className="flex min-h-8 w-full items-center justify-between text-left"
            >
                <span className="text-[11px] font-bold uppercase tracking-wide text-ink-soft">{title}</span>
                <span aria-hidden="true" className={`text-action transition-transform ${expanded ? 'rotate-180' : ''}`}>⌄</span>
            </button>
            {expanded && (
                <>
                    <div
                        ref={scrollerRef}
                        className="flex flex-nowrap gap-2 overflow-x-auto px-0.5 py-0.5 scrollbar-hide"
                        aria-label={carouselLabel}
                    >
                        {children}
                    </div>
                    <ScrollDotsIndicator
                        count={dots.dotCount}
                        activeIndex={dots.activeIndex}
                        onSelect={dots.scrollToIndex}
                        label={`${carouselLabel} pages`}
                    />
                </>
            )}
        </section>
    );
}
