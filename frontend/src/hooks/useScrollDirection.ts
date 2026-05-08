import { useEffect, useState } from 'react';

/**
 * Returns whether the page should treat the user as "scrolling down".
 * Used to hide floating UI when scrolling down and reveal it when scrolling up.
 *
 * - Threshold avoids jitter on tiny scroll deltas.
 * - Always returns false until the user has scrolled past `topOffset` so floating
 *   UI stays visible at the top of the page.
 */
export function useScrollDirection(threshold = 10, topOffset = 80): boolean {
    const [hidden, setHidden] = useState(false);

    useEffect(() => {
        let lastY = window.scrollY;
        let ticking = false;

        const update = () => {
            const y = window.scrollY;
            const delta = y - lastY;
            if (Math.abs(delta) >= threshold) {
                if (y < topOffset) {
                    setHidden(false);
                } else {
                    setHidden(delta > 0);
                }
                lastY = y;
            }
            ticking = false;
        };

        const onScroll = () => {
            if (!ticking) {
                window.requestAnimationFrame(update);
                ticking = true;
            }
        };

        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, [threshold, topOffset]);

    return hidden;
}
