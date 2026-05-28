import { useEffect, useRef, useState } from 'react';
import { searchEvents, type EventSearchResult } from '../api';
import type { CalendarEvent } from '../types';
import { EventListCard } from './EventListPanel';

interface ExplorerEventSearchProps {
    onSelectEvent: (eventId: string) => void;
    triggerLabel?: string;
    compact?: boolean;
    className?: string;
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

export default function ExplorerEventSearch({
    onSelectEvent,
    triggerLabel = 'Search events',
    compact = false,
    className = '',
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
        searchEvents(term, 8)
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
    }, [debounced, open]);

    const term = q.trim();

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
            setActiveIdx((idx) => Math.min(results.length - 1, idx + 1));
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIdx((idx) => Math.max(0, idx - 1));
            return;
        }
        if (event.key === 'Enter' && activeIdx >= 0 && results[activeIdx]) {
            event.preventDefault();
            selectEvent(results[activeIdx].event_id);
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
                className={compact
                    ? 'inline-flex h-6 w-6 items-center justify-center border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition'
                    : 'inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition'}
                data-testid="explorer-event-search-trigger"
            >
                <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-4 w-4"
                    aria-hidden="true"
                >
                    <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M9 3a6 6 0 1 0 3.873 10.59l3.768 3.768a1 1 0 0 0 1.415-1.415l-3.769-3.768A6 6 0 0 0 9 3Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                    />
                </svg>
                {!compact && <span>{triggerLabel}</span>}
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
                                placeholder="Search upcoming events by title"
                                aria-label="Search upcoming events by title"
                                className="w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                            />
                        </div>
                    </div>
                    <div className="max-h-80 overflow-auto bg-slate-50 px-2 py-1.5">
                        {term.length < 2 && (
                            <div className="bg-white p-3 text-xs text-slate-500">
                                Type at least 2 letters to find upcoming events.
                            </div>
                        )}
                        {term.length >= 2 && loading && (
                            <div className="bg-white p-3 text-xs text-slate-500">Searching…</div>
                        )}
                        {term.length >= 2 && !loading && results.length === 0 && (
                            <div className="bg-white p-3 text-xs text-slate-500">
                                No upcoming events match “{term}”.
                            </div>
                        )}
                        {results.map((row, index) => {
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
