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
    onDark?: boolean;
    className?: string;
    /** Render a smaller trigger button (used inline in the passport Timeline tab). */
    small?: boolean;
    /** Search past events (start in the past) instead of upcoming ones. */
    includePast?: boolean;
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
    onDark = false,
    className = '',
    small = false,
    includePast = false,
}: ExplorerEventSearchProps) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const [results, setResults] = useState<EventSearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [activeIdx, setActiveIdx] = useState(-1);
    const [compactPanelTop, setCompactPanelTop] = useState(64);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounced = useDebounced(q, 250);
    const { isAttending } = useAttendingEvents();

    useEffect(() => {
        if (!open || !compact) return;
        const updateTop = () => {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (!rect) return;
            setCompactPanelTop(Math.ceil(rect.bottom + 6));
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
        searchEvents(term, 25, includePast, includePast)
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
    }, [debounced, open, includePast]);

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
        ? 'fixed left-3 right-3 z-[8600] border border-slate-200 bg-white shadow-lg'
        : 'absolute right-0 top-full z-[8600] mt-1 w-80 max-w-[calc(100vw-2rem)] border border-slate-200 bg-white shadow-lg';
    const panelStyle = compact ? { top: compactPanelTop } : undefined;

    return (
        <div ref={containerRef} className={`relative ${className}`}>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-label={triggerLabel}
                title={triggerLabel}
                className={onDark
                    ? 'inline-flex items-center justify-center w-7 h-7 text-white hover:text-gray-200 transition'
                    : compact
                        ? 'inline-flex h-6 w-6 items-center justify-center border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition'
                        : small
                            ? 'inline-flex items-center justify-center gap-1 whitespace-nowrap border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 transition'
                            : 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition'}
                data-testid="explorer-event-search-trigger"
            >
                <img src="/search.png" alt="" aria-hidden="true" className={onDark ? 'h-4 w-4 invert' : small ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
                {!compact && !onDark && <span>{triggerLabel}</span>}
            </button>
            {open && (
                <div className={panelClassName} style={panelStyle}>
                    <div className="border-b border-slate-200 p-2">
                        <div className="flex items-center gap-2 border border-slate-300 bg-white px-2 py-1.5">
                            <svg
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                className="h-4 w-4 text-slate-400"
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
                                placeholder={includePast ? 'Search past events by title' : 'Search upcoming events by title'}
                                aria-label={includePast ? 'Search past events by title' : 'Search upcoming events by title'}
                                className="w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                            />
                        </div>
                    </div>
                    <div className="max-h-80 overflow-auto bg-slate-50 px-2 py-1.5">
                        {term.length < 2 && (
                            <div className="bg-white p-3 text-xs text-slate-500">
                                Type at least 2 letters to find {includePast ? 'past' : 'upcoming'} events.
                            </div>
                        )}
                        {term.length >= 2 && loading && (
                            <div className="bg-white p-3 text-xs text-slate-500">Searching…</div>
                        )}
                        {term.length >= 2 && !loading && visibleResults.length === 0 && (
                            <div className="bg-white p-3 text-xs text-slate-500">
                                No {includePast ? 'past' : 'upcoming'} events match “{term}”.
                                {includePast && (
                                    <>
                                        {' '}
                                        <Link
                                            to="/calendar"
                                            onClick={reset}
                                            className="font-medium text-blue-600 hover:underline"
                                        >
                                            Browse the calendar
                                        </Link>{' '}
                                        to find past events with filters.
                                    </>
                                )}
                            </div>
                        )}
                        {visibleResults.map((row, index) => {
                            if (includePast) {
                                const when = formatPastDate(row.start);
                                return (
                                    <button
                                        key={row.event_id}
                                        type="button"
                                        onClick={() => selectEvent(row.event_id)}
                                        data-testid={`explorer-event-search-result-${index}`}
                                        className={`mb-1.5 flex w-full flex-col items-start gap-0.5 border bg-white px-3 py-2 text-left last:mb-0 hover:bg-slate-50 ${index === activeIdx ? 'border-blue-300 ring-2 ring-blue-300' : 'border-slate-200'}`}
                                    >
                                        <span className="text-sm font-medium text-slate-900">{row.title}</span>
                                        {(when || row.location) && (
                                            <span className="text-xs text-slate-500">
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
                </div>
            )}
        </div>
    );
}
