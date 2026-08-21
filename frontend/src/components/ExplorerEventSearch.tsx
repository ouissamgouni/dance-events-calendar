import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { searchEvents, type EventSearchResult } from '../api';
import type { CalendarEvent } from '../types';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { EventListCard } from './EventListPanel';

interface ExplorerEventSearchProps {
    onSelectEvent: (eventId: string) => void;
    triggerLabel?: string;
    compact?: boolean;
    className?: string;
    /** Render a smaller trigger button (used inline in the passport Timeline tab). */
    small?: boolean;
    /** Search past events (start in the past) instead of upcoming ones. */
    includePast?: boolean;
    /** Render an "Include past" checkbox that lets the user opt past events
     *  into the results (used by the header search). */
    pastToggle?: boolean;
    /** Desktop header variant: keep the single inline input, render the
     *  "Include past" toggle inline in the header box, and show only results
     *  (no duplicate search input) in the dropdown below. */
    headerInline?: boolean;
    /** Callback to open the submit event form (shown in search overlay footer when includePast is true). */
    onOpenSubmitEvent?: () => void;
}

function useDebounced<T>(value: T, ms: number): T {
    const [v, setV] = useState(value);

    useEffect(() => {
        const id = window.setTimeout(() => setV(value), ms);
        return () => window.clearTimeout(id);
    }, [value, ms]);

    return v;
}

function toSearchCardEvent(row: EventSearchResult): CalendarEvent {
    const start = row.start ?? new Date().toISOString();
    return {
        event_id: row.event_id,
        calendar_id: 'search-result',
        title: row.title,
        description: null,
        location: row.location,
        latitude: null,
        longitude: null,
        start,
        end: start,
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: false,
        links: null,
        tags: [],
    };
}

/** Date with the year, so past events are unambiguous in the results list. */
function formatPastDate(iso: string | null): string {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    } catch {
        return '';
    }
}

export default function ExplorerEventSearch({
    onSelectEvent,
    triggerLabel = 'Search events',
    compact = false,
    className = '',
    small = false,
    includePast = false,
    pastToggle = false,
    headerInline = false,
    onOpenSubmitEvent,
}: ExplorerEventSearchProps) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const [results, setResults] = useState<EventSearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [activeIdx, setActiveIdx] = useState(-1);
    const [compactPanelTop, setCompactPanelTop] = useState(64);
    const [pastChecked, setPastChecked] = useState(false);
    // Passport mode (`includePast`) always includes past + excludes attended;
    // the header checkbox only opts past events in, without hiding attended.
    const effectiveIncludePast = includePast || pastChecked;
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounced = useDebounced(q, 250);
    const { isAttending } = useAttendingEvents();

    useEffect(() => {
        if (!open || compact) return;
        const updateTop = () => {
            if (compact && triggerRef.current) {
                const rect = triggerRef.current?.getBoundingClientRect();
                if (!rect) return;
                setCompactPanelTop(Math.ceil(rect.bottom + 6));
            }
        };
        updateTop();
        window.addEventListener('resize', updateTop);
        window.addEventListener('scroll', updateTop, true);
        return () => {
            window.removeEventListener('resize', updateTop);
            window.removeEventListener('scroll', updateTop, true);
        };
    }, [compact, open]);

    useEffect(() => {
        if (!open) return;
        inputRef.current?.focus();
    }, [open]);

    useEffect(() => {
        const onDoc = (event: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(event.target as Node)
            ) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, []);

    useEffect(() => {
        if (!open) return;
        const term = debounced.trim();
        if (term.length < 2) {
            setResults([]);
            setLoading(false);
            setActiveIdx(-1);
            return;
        }
        let cancelled = false;
        setLoading(true);
        searchEvents(term, 25, effectiveIncludePast, includePast)
            .then((rows) => {
                if (cancelled) return;
                setResults(rows);
                setActiveIdx(rows.length > 0 ? 0 : -1);
            })
            .catch(() => {
                if (cancelled) return;
                setResults([]);
                setActiveIdx(-1);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [debounced, open, effectiveIncludePast, includePast]);

    const term = q.trim();

    // In past-event (passport) mode, only offer events the viewer hasn't
    // already added to their passport.
    const visibleResults = useMemo(
        () => (includePast ? results.filter((r) => !isAttending(r.event_id)) : results),
        [results, includePast, isAttending],
    );

    const reset = () => {
        setOpen(false);
        setQ('');
        setResults([]);
        setLoading(false);
        setActiveIdx(-1);
    };

    const selectEvent = (eventId: string) => {
        onSelectEvent(eventId);
        reset();
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIdx((idx) => Math.min(visibleResults.length - 1, idx + 1));
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIdx((idx) => Math.max(0, idx - 1));
            return;
        }
        if (event.key === 'Enter' && activeIdx >= 0 && visibleResults[activeIdx]) {
            event.preventDefault();
            selectEvent(visibleResults[activeIdx].event_id);
        }
    };

    const panelClassName = compact
        ? 'fixed left-3 right-3 z-[8600] border border-line bg-surface shadow-lg'
        : 'absolute right-0 top-full z-[8600] mt-1 w-80 max-w-[calc(100vw-2rem)] border border-line bg-surface shadow-lg';
    const panelStyle = compact ? { top: compactPanelTop } : undefined;

    // Desktop inline mode: show input directly instead of trigger button
    const isDesktopInline = !compact && !small;

    return (
        <div ref={containerRef} className={`relative ${className}`}>
            {/* Desktop inline: show input directly */}
            {isDesktopInline && (
                <div className="hidden sm:flex items-center gap-2 border border-line bg-canvas px-2 py-1">
                    <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="h-4 w-4 text-muted flex-shrink-0"
                        aria-hidden="true"
                    >
                        <path
                            fillRule="evenodd"
                            clipRule="evenodd"
                            d="M9 3a6 6 0 1 0 3.873 10.59l3.768 3.768a1 1 0 0 0 1.415-1.415l-3.769-3.768A6 6 0 0 0 9 3Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                        />
                    </svg>
                    <input
                        ref={inputRef}
                        type="text"
                        value={q}
                        onChange={(event) => setQ(event.target.value)}
                        onKeyDown={onKeyDown}
                        onFocus={() => setOpen(true)}
                        placeholder={headerInline && effectiveIncludePast ? 'Search past events' : triggerLabel}
                        aria-label={triggerLabel}
                        className="flex-1 bg-transparent text-xs text-ink placeholder:text-muted focus:outline-none"
                    />
                    {headerInline && pastToggle && (
                        <label className="flex items-center gap-1 text-[11px] text-ink-soft whitespace-nowrap select-none">
                            <input
                                type="checkbox"
                                checked={pastChecked}
                                onChange={(event) => setPastChecked(event.target.checked)}
                                className="h-3 w-3"
                                data-testid="explorer-event-search-include-past"
                            />
                            Past
                        </label>
                    )}
                </div>
            )}

            {/* Mobile/compact: trigger button */}
            {!isDesktopInline && (
                <button
                    ref={triggerRef}
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    aria-label={triggerLabel}
                    title={triggerLabel}
                    className={compact
                        ? 'inline-flex h-11 w-11 items-center justify-center text-ink-soft hover:text-ink transition'
                        : small
                            ? 'inline-flex items-center justify-center gap-1 whitespace-nowrap border border-line bg-surface px-2 py-1 text-xs font-medium text-ink hover:bg-canvas transition'
                            : 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap border border-line bg-surface px-2.5 py-1.5 text-sm font-medium text-ink hover:bg-canvas transition'}
                    data-testid="explorer-event-search-trigger"
                >
                    <img src="/search.png" alt="" aria-hidden="true" className={compact ? 'h-6 w-6' : small ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
                    {!compact && <span>{triggerLabel}</span>}
                </button>
            )}
            {open && (
                <div className={panelClassName} style={panelStyle}>
                    {!headerInline && (
                        <div className="border-b border-line p-2">
                            <div className="flex items-center gap-2">
                                {pastToggle && (
                                    <label className="flex items-center gap-1 text-xs text-ink-soft whitespace-nowrap select-none">
                                        <input
                                            type="checkbox"
                                            checked={pastChecked}
                                            onChange={(event) => setPastChecked(event.target.checked)}
                                            className="h-3.5 w-3.5"
                                            data-testid="explorer-event-search-include-past"
                                        />
                                        Include past
                                    </label>
                                )}
                                <div className="flex flex-1 items-center gap-2 border border-line bg-surface px-2 py-1.5">
                                    <svg
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                        className="h-4 w-4 text-muted"
                                        aria-hidden="true"
                                    >
                                        <path
                                            fillRule="evenodd"
                                            clipRule="evenodd"
                                            d="M9 3a6 6 0 1 0 3.873 10.59l3.768 3.768a1 1 0 0 0 1.415-1.415l-3.769-3.768A6 6 0 0 0 9 3Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                                        />
                                    </svg>
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={q}
                                        onChange={(event) => setQ(event.target.value)}
                                        onKeyDown={onKeyDown}
                                        placeholder={effectiveIncludePast ? 'Search past events by title' : 'Search upcoming events by title'}
                                        aria-label={effectiveIncludePast ? 'Search past events by title' : 'Search upcoming events by title'}
                                        className="w-full bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
                                    />
                                </div>
                            </div>
                        </div>
                    )}
                    <div className="max-h-80 overflow-auto bg-canvas px-2 py-1.5">
                        {term.length < 2 && (
                            <div className="bg-surface p-3 text-xs text-ink-soft">
                                Type at least 2 letters to find {includePast ? 'past' : 'upcoming'} events.
                            </div>
                        )}
                        {term.length >= 2 && loading && (
                            <div className="bg-surface p-3 text-xs text-ink-soft">Searching…</div>
                        )}
                        {term.length >= 2 && !loading && visibleResults.length === 0 && (
                            <div className="bg-surface p-3 text-xs text-ink-soft">
                                No {effectiveIncludePast ? 'past' : 'upcoming'} events match “{term}”.
                                {effectiveIncludePast && (
                                    <>
                                        {' '}
                                        <Link
                                            to="/calendar"
                                            onClick={reset}
                                            className="font-medium text-action hover:underline"
                                        >
                                            Browse the calendar
                                        </Link>{' '}
                                        to find past events with filters.
                                    </>
                                )}
                            </div>
                        )}
                        {visibleResults.map((row, index) => {
                            if (effectiveIncludePast) {
                                const when = formatPastDate(row.start);
                                return (
                                    <button
                                        key={row.event_id}
                                        type="button"
                                        onClick={() => selectEvent(row.event_id)}
                                        data-testid={`explorer-event-search-result-${index}`}
                                        className={`mb-1.5 flex w-full flex-col items-start gap-0.5 border bg-surface px-3 py-2 text-left last:mb-0 hover:bg-canvas ${index === activeIdx ? 'border-blue-300 ring-2 ring-blue-300' : 'border-line'}`}
                                    >
                                        <span className="text-sm font-medium text-ink">{row.title}</span>
                                        {(when || row.location) && (
                                            <span className="text-xs text-ink-soft">
                                                {[when, row.location].filter(Boolean).join(' · ')}
                                            </span>
                                        )}
                                    </button>
                                );
                            }
                            const event = toSearchCardEvent(row);
                            return (
                                <div
                                    key={row.event_id}
                                    className={`mb-1.5 last:mb-0 ${index === activeIdx ? 'ring-2 ring-blue-300' : ''}`}
                                    data-testid={`explorer-event-search-result-${index}`}
                                >
                                    <EventListCard
                                        event={event}
                                        mapBounds={null}
                                        onEventClick={() => selectEvent(row.event_id)}
                                        showPrices={false}
                                        showPopularity={false}
                                        popularityThreshold={0}
                                        trendingTopN={0}
                                        trendingTopPercent={0}
                                        allViewCounts={[]}
                                        followingBadgeEnabled={false}
                                        showRatings={false}
                                        isSavedFlag={false}
                                    />
                                </div>
                            );
                        })}
                    </div>
                    {includePast && onOpenSubmitEvent && (
                        <div className="border-t border-line bg-surface px-3 py-2 text-center text-xs">
                            <button
                                type="button"
                                onClick={() => {
                                    onOpenSubmitEvent();
                                    reset();
                                }}
                                className="font-medium text-action hover:underline"
                            >
                                Missing event? Add it
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
