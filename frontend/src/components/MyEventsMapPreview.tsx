import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CalendarEvent } from '../types';
import EventCard from './EventCard';
import ScrollDotsIndicator from './ScrollDots';
import ProgramAction from './ProgramAction';

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
    showProgramAction?: boolean;
    /** Reports the sheet's pixel height so a floating map control can sit
     * just above it instead of overlapping. */
    onHeightChange?: (height: number) => void;
    /** Hides the preview (× button or swipe down). */
    onCollapse?: () => void;
    /** Card-level × (e.g. remove from saved). */
    onDismiss?: () => void;
    dismissLabel?: string;
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
    showProgramAction = false,
    onHeightChange,
    onCollapse,
    onDismiss,
    dismissLabel,
}: Props) {
    const pointerStart = useRef<{ x: number; y: number } | null>(null);
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

    const finishSwipe = (clientX: number, clientY: number) => {
        if (pointerStart.current == null) return;
        const dx = clientX - pointerStart.current.x;
        const dy = clientY - pointerStart.current.y;
        pointerStart.current = null;
        if (Math.abs(dy) > Math.abs(dx)) {
            if (dy > 48) onCollapse?.();
            return;
        }
        if (dx < -48 && hasNext) onNext();
        if (dx > 48 && hasPrevious) onPrevious();
    };

    return (
        <div
            ref={sheetRef}
            className="relative z-[760] shrink-0"
        >
            <div
                role="group"
                aria-label={sequence != null ? `Event ${sequence}: ${event.title}` : event.title}
                tabIndex={0}
                onPointerDown={(pointerEvent) => { pointerStart.current = { x: pointerEvent.clientX, y: pointerEvent.clientY }; }}
                onPointerUp={(pointerEvent) => finishSwipe(pointerEvent.clientX, pointerEvent.clientY)}
                onPointerCancel={() => { pointerStart.current = null; }}
                onKeyDown={(keyEvent) => {
                    if (keyEvent.key === 'ArrowLeft' && hasPrevious) onPrevious();
                    if (keyEvent.key === 'ArrowRight' && hasNext) onNext();
                }}
                className="relative w-full touch-none overflow-hidden rounded-t-card bg-surface px-1 pb-2 shadow-[0_-4px_16px_rgba(15,23,42,0.12)] animate-slide-up focus:outline-none"
                data-testid="my-events-map-preview"
            >
                <div className="flex h-5 items-center justify-center">
                    {/* eslint-disable-next-line no-restricted-syntax -- drag handle is a pill by design */}
                    <span className="h-1 w-10 rounded-full bg-line" aria-hidden />
                    {onCollapse && (
                        <button
                            type="button"
                            onClick={onCollapse}
                            aria-label="Hide event preview"
                            className="absolute right-0 top-0 z-[3] flex h-7 w-11 items-center justify-center text-muted transition hover:bg-canvas hover:text-ink-soft"
                            data-testid="map-preview-collapse"
                        >
                            ✕
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-0.5">
                    <button
                        type="button"
                        onClick={onPrevious}
                        disabled={!hasPrevious}
                        aria-label="Previous event"
                        className="shrink-0 inline-flex h-9 w-10 items-center justify-center text-ink transition hover:text-action disabled:cursor-not-allowed disabled:opacity-0"
                    >
                        <ChevronLeft className="h-6 w-6" aria-hidden="true" />
                    </button>
                    <div className="min-w-0 flex-1">
                        <EventCard
                            event={event}
                            onOpen={onOpen}
                            dateSequence={sequence}
                            dateTopRow
                            borderless
                            compact
                            tagsFitWidth
                            twoLineTitle
                            showAvatars={showAvatars}
                            showTags={showTags}
                            showReviews={showReviews}
                            showPrice={showPrice}
                            showActions={showActions}
                            actions={actions}
                            showRatings={showRatings}
                            onDismiss={onDismiss}
                            dismissLabel={dismissLabel}
                            followingBadgeEnabled={followingBadgeEnabled}
                            goingIconVariant="hand"
                            bottomSlot={showProgramAction ? <ProgramAction event={event} /> : undefined}
                            testId="my-events-map-card"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={onNext}
                        disabled={!hasNext}
                        aria-label="Next event"
                        className="shrink-0 inline-flex h-9 w-10 items-center justify-center text-ink transition hover:text-action disabled:cursor-not-allowed disabled:opacity-0"
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
                        className="mx-auto mt-1"
                    />
                )}
            </div>
        </div>
    );
}
