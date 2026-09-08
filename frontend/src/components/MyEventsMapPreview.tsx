import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CalendarEvent } from '../types';
import EventCard from './EventCard';
import ScrollDotsIndicator from './ScrollDots';

interface Props {
    event: CalendarEvent;
    /** Order-number badge in the date rail (journey view). Omit to hide it. */
    sequence?: number;
    hasPrevious: boolean;
    hasNext: boolean;
    onPrevious: () => void;
    onNext: () => void;
    onOpen: () => void;
    /** Position of this event within the list + total, for the dot carousel. */
    index?: number;
    count?: number;
    onSelectIndex?: (index: number) => void;
    /** Show the attendee avatar stack (explorer preview shows it). */
    showAvatars?: boolean;
    /** Show tags + reviews line (explorer preview shows them). */
    showTags?: boolean;
    showReviews?: boolean;
    /** Show the price / discount line (explorer preview shows it). */
    showPrice?: boolean;
    /** Show the Save / I'm going action cluster (explorer preview shows it). */
    showActions?: boolean;
    /** Which actions to offer when `showActions` is set. */
    actions?: ReadonlyArray<'save' | 'going'>;
    showRatings?: boolean;
    followingBadgeEnabled?: boolean;
    /** Reports the sheet's pixel height so a floating map control can sit
     * just above it instead of overlapping. */
    onHeightChange?: (height: number) => void;
}

/**
 * Swipeable bottom-sheet preview for the map surfaces: prev/next chevrons,
 * horizontal swipe, and left/right arrow keys page through the list. The
 * card itself is the shared, borderless `EventCard` so the sheet matches the
 * list cards. Reused by My Events (journey, with order numbers) and the
 * Explorer map (no order numbers, full elements).
 */
export default function MyEventsMapPreview({
    event,
    sequence,
    hasPrevious,
    hasNext,
    onPrevious,
    onNext,
    onOpen,
    index,
    count,
    onSelectIndex,
    showAvatars = false,
    showTags = false,
    showReviews = false,
    showPrice = false,
    showActions = false,
    actions,
    showRatings = false,
    followingBadgeEnabled = false,
    onHeightChange,
}: Props) {
    const pointerStart = useRef<number | null>(null);
    const sheetRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const node = sheetRef.current;
        if (!node || !onHeightChange) return;
        const report = () => onHeightChange(node.offsetHeight);
        report();
        const observer = new ResizeObserver(report);
        observer.observe(node);
        return () => {
            observer.disconnect();
            onHeightChange(0);
        };
    }, [onHeightChange]);

    const finishSwipe = (clientX: number) => {
        if (pointerStart.current == null) return;
        const distance = clientX - pointerStart.current;
        pointerStart.current = null;
        if (distance < -48 && hasNext) onNext();
        if (distance > 48 && hasPrevious) onPrevious();
    };

    return (
        <div
            ref={sheetRef}
            role="group"
            aria-label={sequence != null ? `Event ${sequence}: ${event.title}` : event.title}
            tabIndex={0}
            onPointerDown={(pointerEvent) => { pointerStart.current = pointerEvent.clientX; }}
            onPointerUp={(pointerEvent) => finishSwipe(pointerEvent.clientX)}
            onPointerCancel={() => { pointerStart.current = null; }}
            onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'ArrowLeft' && hasPrevious) onPrevious();
                if (keyEvent.key === 'ArrowRight' && hasNext) onNext();
            }}
            className="shrink-0 border-t border-line bg-surface px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 shadow-xl focus:outline-none"
            data-testid="my-events-map-preview"
        >
            <div className="mx-auto flex max-w-6xl items-center gap-2">
                <button
                    type="button"
                    onClick={onPrevious}
                    disabled={!hasPrevious}
                    aria-label="Previous event"
                    className="shrink-0 inline-flex h-9 w-7 items-center justify-center text-ink transition hover:text-action disabled:cursor-not-allowed disabled:opacity-0"
                >
                    <ChevronLeft className="h-6 w-6" aria-hidden="true" />
                </button>
                <div className="min-w-0 flex-1">
                    <EventCard
                        event={event}
                        onOpen={onOpen}
                        dateSequence={sequence}
                        borderless
                        twoLineTitle
                        showAvatars={showAvatars}
                        showTags={showTags}
                        showReviews={showReviews}
                        showPrice={showPrice}
                        showActions={showActions}
                        actions={actions}
                        showRatings={showRatings}
                        followingBadgeEnabled={followingBadgeEnabled}
                        goingIconVariant="hand"
                        testId="my-events-map-card"
                    />
                </div>
                <button
                    type="button"
                    onClick={onNext}
                    disabled={!hasNext}
                    aria-label="Next event"
                    className="shrink-0 inline-flex h-9 w-7 items-center justify-center text-ink transition hover:text-action disabled:cursor-not-allowed disabled:opacity-0"
                >
                    <ChevronRight className="h-6 w-6" aria-hidden="true" />
                </button>
            </div>
            {count != null && count > 1 && index != null && index >= 0 && (
                <ScrollDotsIndicator
                    count={count}
                    activeIndex={index}
                    onSelect={(i) => onSelectIndex?.(i)}
                    label="Event position"
                    className="mx-auto mt-2"
                />
            )}
        </div>
    );
}
