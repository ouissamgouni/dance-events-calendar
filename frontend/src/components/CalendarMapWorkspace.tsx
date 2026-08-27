import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type FullCalendar from '@fullcalendar/react';
import { CalendarDays, ChevronLeft, ChevronRight, Map } from 'lucide-react';
import type { CalendarEvent } from '../types';
import type { CalendarViewMode } from './Calendar';

const Calendar = lazy(() => import('./Calendar'));

interface Props {
    events: CalendarEvent[];
    map?: (calendarVisible: boolean) => ReactNode;
    viewMode: CalendarViewMode;
    onViewModeChange?: (mode: CalendarViewMode) => void;
    rangeSelector?: 'always' | 'mobile' | 'hidden';
    initialDate?: string;
    sinceDate?: string;
    onDatesChange?: (start: Date, end: Date) => void;
    onEventClick: (event: CalendarEvent, clickRect?: DOMRect) => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    offMapEventIds?: Set<string>;
    layout?: 'page' | 'fill' | 'remaining-map';
}

const MIN_REMAINING_MAP_HEIGHT = 200;

function rangeTitle(start: Date, end: Date): string {
    const endInclusive = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const spanDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    if (spanDays > 28) {
        const midpoint = new Date((start.getTime() + end.getTime()) / 2);
        return midpoint.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    }
    const sameYear = start.getFullYear() === endInclusive.getFullYear();
    const sameMonth = sameYear && start.getMonth() === endInclusive.getMonth();
    const startLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const endLabel = endInclusive.toLocaleDateString(undefined, {
        month: sameMonth ? undefined : 'short',
        day: 'numeric',
        year: sameYear ? undefined : 'numeric',
    });
    return `${startLabel} – ${endLabel}${sameYear ? `, ${endInclusive.getFullYear()}` : ''}`;
}

export default function CalendarMapWorkspace({
    events,
    map,
    viewMode,
    onViewModeChange,
    rangeSelector = 'always',
    initialDate,
    sinceDate,
    onDatesChange,
    onEventClick,
    hoveredEventId,
    onEventHover,
    offMapEventIds,
    layout = 'page',
}: Props) {
    const calendarRef = useRef<FullCalendar>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const calendarContainerRef = useRef<HTMLDivElement>(null);
    const [calendarVisible, setCalendarVisible] = useState(true);
    const [title, setTitle] = useState('');
    const [remainingMapHeight, setRemainingMapHeight] = useState(0);
    const remainingMapLayout = layout === 'remaining-map';

    const measureRemainingMap = useCallback(() => {
        if (!remainingMapLayout || !map) {
            setRemainingMapHeight(0);
            return;
        }
        const content = contentRef.current;
        const calendar = calendarContainerRef.current;
        if (!content || !calendar) return;
        const remaining = Math.max(0, content.clientHeight - calendar.scrollHeight);
        setRemainingMapHeight(remaining >= MIN_REMAINING_MAP_HEIGHT ? remaining : 0);
    }, [map, remainingMapLayout]);

    useLayoutEffect(measureRemainingMap, [events, measureRemainingMap, title, viewMode]);

    useEffect(() => {
        if (!remainingMapLayout) return;
        const content = contentRef.current;
        const calendar = calendarContainerRef.current;
        if (!content || !calendar) return;
        const observer = new ResizeObserver(measureRemainingMap);
        observer.observe(content);
        observer.observe(calendar);
        window.addEventListener('resize', measureRemainingMap);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', measureRemainingMap);
        };
    }, [measureRemainingMap, remainingMapLayout]);

    const handleDatesChange = useCallback((start: Date, end: Date) => {
        setTitle(rangeTitle(start, end));
        onDatesChange?.(start, end);
    }, [onDatesChange]);

    const rangeControls = rangeSelector !== 'hidden' && onViewModeChange ? (
        <div className={`flex shrink-0 gap-1 bg-canvas p-1 ${rangeSelector === 'mobile' ? 'sm:hidden' : ''}`} aria-label="Calendar range">
            <button
                type="button"
                className={`px-2 py-1 text-xs font-medium transition ${viewMode === '3week' ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`}
                onClick={() => onViewModeChange('3week')}
                aria-pressed={viewMode === '3week'}
            >
                3 wk
            </button>
            <button
                type="button"
                className={`px-2 py-1 text-xs font-medium transition ${viewMode === 'month' ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`}
                onClick={() => onViewModeChange('month')}
                aria-pressed={viewMode === 'month'}
            >
                30d
            </button>
        </div>
    ) : null;

    return (
        <section className={layout === 'fill' || remainingMapLayout ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : ''} data-testid="calendar-map-workspace">
            <div className={`flex shrink-0 flex-wrap items-center gap-3 ${layout === 'fill' ? 'border-b border-line bg-surface px-3 py-2' : 'mb-4'}`}>
                <div className="flex items-center gap-2">
                    <div className="flex">
                        <button type="button" className="inline-flex h-8 w-8 items-center justify-center border border-line bg-surface text-ink hover:bg-canvas" onClick={() => calendarRef.current?.getApi().prev()} aria-label="Previous calendar period">
                            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button type="button" className="h-8 border-y border-line bg-surface px-2.5 text-xs font-medium text-ink hover:bg-canvas" onClick={() => calendarRef.current?.getApi().today()}>
                            Today
                        </button>
                        <button type="button" className="inline-flex h-8 w-8 items-center justify-center border border-line bg-surface text-ink hover:bg-canvas" onClick={() => calendarRef.current?.getApi().next()} aria-label="Next calendar period">
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </div>
                    <h2 className="whitespace-nowrap text-xs font-semibold text-ink sm:text-sm">{title}</h2>
                </div>
                {rangeControls}
                {map && !remainingMapLayout && (
                    <button
                        type="button"
                        onClick={() => setCalendarVisible((visible) => !visible)}
                        className="inline-flex h-8 w-8 items-center justify-center border border-line bg-surface text-ink transition hover:bg-canvas"
                        aria-pressed={!calendarVisible}
                        aria-label={calendarVisible ? 'Show map only' : 'Show calendar and map'}
                        title={calendarVisible ? 'Show map only' : 'Show calendar and map'}
                        data-testid="calendar-map-toggle"
                    >
                        {calendarVisible ? <Map className="h-4 w-4" aria-hidden="true" /> : <CalendarDays className="h-4 w-4" aria-hidden="true" />}
                    </button>
                )}
            </div>
            <div ref={contentRef} className={remainingMapLayout ? 'flex min-h-0 flex-1 flex-col overflow-hidden p-2' : layout === 'fill' ? 'flex min-h-0 flex-1 flex-col gap-2 p-2 lg:flex-row' : 'flex flex-col gap-6 lg:flex-row'} data-testid="calendar-map-content">
                <div ref={calendarContainerRef} className={!map || calendarVisible
                    ? remainingMapLayout ? 'min-h-0 min-w-0 max-h-full shrink-0 overflow-auto' : layout === 'fill' ? 'min-h-0 min-w-0 flex-1 overflow-auto' : 'min-w-0 flex-1'
                    : 'calendar-hide-grid h-0 overflow-hidden'
                } data-testid="calendar-container">
                    <Suspense fallback={<p className="py-20 text-center text-sm text-muted">Loading calendar…</p>}>
                        <Calendar
                            ref={calendarRef}
                            events={events}
                            initialDate={initialDate}
                            sinceDate={sinceDate}
                            onDatesChange={handleDatesChange}
                            onEventClick={onEventClick}
                            hoveredEventId={hoveredEventId}
                            onEventHover={onEventHover}
                            offMapEventIds={offMapEventIds}
                            viewMode={viewMode}
                        />
                    </Suspense>
                </div>
                {map && (!remainingMapLayout || remainingMapHeight > 0) && (
                    <div className={calendarVisible
                        ? remainingMapLayout ? 'relative shrink-0' : layout === 'fill' ? 'relative min-h-[240px] flex-1 lg:min-w-[360px]' : 'h-[400px] lg:sticky lg:top-6 lg:h-[calc(100vh-200px)] lg:w-[420px] lg:shrink-0'
                        : layout === 'fill' ? 'relative min-h-0 flex-1' : 'h-[70vh] w-full'
                    } style={remainingMapLayout ? { height: remainingMapHeight } : undefined} data-testid="calendar-remaining-map">
                        {map(calendarVisible)}
                    </div>
                )}
            </div>
        </section>
    );
}
