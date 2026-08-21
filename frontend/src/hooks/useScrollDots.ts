import { useCallback, useEffect, useState, type DependencyList, type RefObject } from 'react';

export interface ScrollDots {
    /** Number of viewport "pages" the rail can scroll through (0 or 1 = no overflow). */
    dotCount: number;
    /** Index of the page currently in view. */
    activeIndex: number;
    /** Smoothly scroll the rail to the given page index. */
    scrollToIndex: (index: number) => void;
}

/**
 * Tracks the scroll position of a horizontal rail as discrete viewport "pages".
 *
 * - `dotCount` is `ceil(scrollWidth / clientWidth)`; it stays 0 when content fits
 *   (no overflow) so callers can hide the indicator.
 * - Recomputes on scroll (rAF-throttled) and on element resize.
 * - Pass `deps` (e.g. collapsed state, item count) so the effect re-binds when the
 *   scroller is conditionally rendered or its contents change.
 */
export function useScrollDots(
    ref: RefObject<HTMLElement | null>,
    deps: DependencyList = [],
): ScrollDots {
    const [dotCount, setDotCount] = useState(0);
    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => {
        const el = ref.current;
        if (!el) {
            setDotCount(0);
            setActiveIndex(0);
            return;
        }

        let ticking = false;
        const measure = () => {
            ticking = false;
            const { scrollWidth, clientWidth, scrollLeft } = el;
            if (clientWidth === 0) return;
            const overflow = scrollWidth - clientWidth;
            const pages = overflow > 1 ? Math.ceil(scrollWidth / clientWidth) : 0;
            const index = pages > 0 ? Math.round(scrollLeft / clientWidth) : 0;
            setDotCount(pages);
            setActiveIndex(Math.min(Math.max(index, 0), Math.max(pages - 1, 0)));
        };

        const onScroll = () => {
            if (!ticking) {
                ticking = true;
                window.requestAnimationFrame(measure);
            }
        };

        measure();
        el.addEventListener('scroll', onScroll, { passive: true });
        const observer = new ResizeObserver(measure);
        observer.observe(el);

        return () => {
            el.removeEventListener('scroll', onScroll);
            observer.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ref, ...deps]);

    const scrollToIndex = useCallback(
        (index: number) => {
            const el = ref.current;
            if (!el) return;
            el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
        },
        [ref],
    );

    return { dotCount, activeIndex, scrollToIndex };
}
