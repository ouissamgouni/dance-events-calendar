import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { fetchEventsByIds, searchEvents, type EventSearchDateScope, type EventSearchResult } from '../api';
import type { CalendarEvent } from '../types';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import SearchEventCard, { type SearchEventCardPurpose } from './SearchEventCard';

interface ExplorerEventSearchProps {
    onSelectEvent: (eventId: string) => void;
    onSelectResult?: (result: EventSearchResult) => void;
    triggerLabel?: string;
    compact?: boolean;
    className?: string;
    /** Render a smaller trigger button (used inline in the passport Timeline tab). */
    small?: boolean;
    triggerIcon?: 'search' | 'plus';
    /** Restrict results to the date scope required by the surrounding workflow. */
    dateScope?: EventSearchDateScope;
    /** Exclude events the signed-in viewer already marked as attended. */
    excludeAttended?: boolean;
    /** Render an "Include past" checkbox that lets the user opt past events
     *  into the results (used by the header search). */
    pastToggle?: boolean;
    /** Desktop header variant: keep the single inline input, render the
     *  "Include past" toggle inline in the header box, and show only results
     *  (no duplicate search input) in the dropdown below. */
    headerInline?: boolean;
    /** Callback to open the submit event form in past-event selection flows. */
    onOpenSubmitEvent?: () => void;
    /** Always-open result surface used when search is embedded in page content. */
    embedded?: boolean;
    /** Text prepended to the minimum-query instruction in embedded contexts. */
    guidancePrefix?: string;
    resultFilter?: (result: EventSearchResult) => boolean;
    onNoResultsAction?: () => void;
    noResultsActionLabel?: string;
    /** Render the dropdown under document.body when an ancestor clips overflow. */
    portal?: boolean;
    /** Browse opens event details with card actions; select delegates to a context confirmation flow. */
    resultPurpose?: SearchEventCardPurpose;
}

function OptionalPortal({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
    return enabled ? createPortal(children, document.body) : children;
}

function useDebounced<T>(value: T, ms: number): T {
    const [v, setV] = useState(value);

    useEffect(() => {
        const id = window.setTimeout(() => setV(value), ms);
        return () => window.clearTimeout(id);
    }, [value, ms]);

    return v;
}

export default function ExplorerEventSearch({
    onSelectEvent,
    onSelectResult,
    triggerLabel = 'Search events',
    compact = false,
    className = '',
    small = false,
    triggerIcon = 'search',
    dateScope = 'upcoming',
    excludeAttended = false,
    pastToggle = false,
    headerInline = false,
    onOpenSubmitEvent,
    embedded = false,
    guidancePrefix,
    resultFilter,
    onNoResultsAction,
    noResultsActionLabel = 'Suggest an event',
    portal = false,
    resultPurpose = 'browse',
}: ExplorerEventSearchProps) {
    const [open, setOpen] = useState(embedded);
    const [q, setQ] = useState('');
    const [results, setResults] = useState<EventSearchResult[]>([]);
    const [eventsById, setEventsById] = useState<Map<string, CalendarEvent>>(new Map());
    const [loading, setLoading] = useState(false);
    const [activeIdx, setActiveIdx] = useState(-1);
    const [pastChecked, setPastChecked] = useState(false);
    const effectiveDateScope: EventSearchDateScope = pastToggle && pastChecked ? 'all' : dateScope;
    const containerRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [portalStyle, setPortalStyle] = useState<React.CSSProperties>();
    const debounced = useDebounced(q, 250);
    const { isAttending } = useAttendingEvents();

    useEffect(() => {
        if (!open && !embedded) return;
        inputRef.current?.focus();
    }, [embedded, open]);

    useEffect(() => {
        const onDoc = (event: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(event.target as Node) &&
                !panelRef.current?.contains(event.target as Node)
            ) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, []);

    useEffect(() => {
        if (!portal || !open) return;
        const positionPanel = () => {
            const trigger = triggerRef.current;
            if (!trigger) return;
            const rect = trigger.getBoundingClientRect();
            const width = Math.min(320, window.innerWidth - 24);
            setPortalStyle({
                position: 'fixed',
                top: rect.bottom + 4,
                left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
                width,
            });
        };
        positionPanel();
        window.addEventListener('resize', positionPanel);
        window.addEventListener('scroll', positionPanel, true);
        return () => {
            window.removeEventListener('resize', positionPanel);
            window.removeEventListener('scroll', positionPanel, true);
        };
    }, [open, portal]);

    useEffect(() => {
        if (!open && !embedded) return;
        const term = debounced.trim();
        if (term.length < 2) {
            setResults([]);
            setEventsById(new Map());
            setLoading(false);
            setActiveIdx(-1);
            return;
        }
        let cancelled = false;
        setLoading(true);
        searchEvents(term, {
            limit: 25,
            dateScope: effectiveDateScope,
            excludeAttended,
        })
            .then(async (rows) => {
                if (cancelled) return;
                const events = await fetchEventsByIds(rows.map((row) => row.event_id)).catch(() => []);
                if (cancelled) return;
                setResults(rows);
                setEventsById(new Map(events.map((event) => [event.event_id, event])));
                setActiveIdx(rows.length > 0 ? 0 : -1);
            })
            .catch(() => {
                if (cancelled) return;
                setResults([]);
                setEventsById(new Map());
                setActiveIdx(-1);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [debounced, embedded, open, effectiveDateScope, excludeAttended]);

    const term = q.trim();

    const visibleResults = useMemo(
        () => {
            const attendanceFiltered = excludeAttended ? results.filter((result) => !isAttending(result.event_id)) : results;
            return resultFilter ? attendanceFiltered.filter(resultFilter) : attendanceFiltered;
        },
        [results, excludeAttended, isAttending, resultFilter],
    );

    const reset = () => {
        if (!embedded) setOpen(false);
        setQ('');
        setResults([]);
        setEventsById(new Map());
        setLoading(false);
        setActiveIdx(-1);
    };

    const selectEvent = (result: EventSearchResult) => {
        onSelectEvent(result.event_id);
        onSelectResult?.(result);
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
            selectEvent(visibleResults[activeIdx]);
        }
    };

    const panelClassName = portal
        ? 'z-[8600] border border-line bg-surface shadow-lg'
        : embedded
            ? 'w-full border-y border-line bg-surface'
            : compact
                ? 'fixed left-3 right-3 z-[8600] border border-line bg-surface shadow-lg'
                : 'absolute right-0 top-full z-[8600] mt-1 w-80 max-w-[calc(100vw-2rem)] border border-line bg-surface shadow-lg';
    const panelStyle = portal
        ? portalStyle
        : compact
            ? { top: 'calc(64px + env(safe-area-inset-top) + 6px)' }
            : undefined;

    // Desktop inline mode: show input directly instead of trigger button
    const isDesktopInline = !embedded && !compact && !small;

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
                        placeholder="Search events, places, or tags…"
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
            {!isDesktopInline && !embedded && (
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
                    {triggerIcon === 'plus'
                        ? <Plus className={small ? 'h-4 w-4' : 'h-5 w-5'} aria-hidden="true" />
                        : <img src="/search.png" alt="" aria-hidden="true" className={compact ? 'h-6 w-6' : small ? 'h-3.5 w-3.5' : 'h-4 w-4'} />}
                    {!compact && <span>{triggerLabel}</span>}
                </button>
            )}
            {(open || embedded) && (
                <OptionalPortal enabled={portal}>
                    <div ref={panelRef} className={panelClassName} style={panelStyle}>
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
                                            placeholder="Search events, places, or tags…"
                                            aria-label={embedded ? triggerLabel : 'Search events, places, or tags'}
                                            className="w-full bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                        <div className="max-h-80 overflow-auto bg-canvas px-2 py-1.5">
                            {term.length < 2 && (
                                <div className="bg-surface p-3 text-xs text-ink-soft">
                                    {guidancePrefix ? `${guidancePrefix} ` : ''}Type at least 2 letters to find {effectiveDateScope === 'all' ? 'events' : `${effectiveDateScope} events`}.
                                </div>
                            )}
                            {term.length >= 2 && loading && (
                                <div className="bg-surface p-3 text-xs text-ink-soft">Searching…</div>
                            )}
                            {term.length >= 2 && !loading && visibleResults.length === 0 && (
                                <div className="bg-surface p-3 text-xs text-ink-soft">
                                    No {effectiveDateScope === 'all' ? '' : `${effectiveDateScope} `}events match “{term}”.
                                    {effectiveDateScope !== 'upcoming' && !embedded && (
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
                                    {onNoResultsAction && (
                                        <button type="button" onClick={onNoResultsAction} className="ml-1 font-semibold text-action hover:underline">
                                            {noResultsActionLabel}
                                        </button>
                                    )}
                                </div>
                            )}
                            {visibleResults.map((row, index) => (
                                <div key={row.event_id} className="mb-1.5 last:mb-0">
                                    <SearchEventCard
                                        result={row}
                                        event={eventsById.get(row.event_id)}
                                        onOpen={() => selectEvent(row)}
                                        purpose={resultPurpose}
                                        showPastLabel={effectiveDateScope === 'all'}
                                        highlighted={index === activeIdx}
                                        testId={`explorer-event-search-result-${index}`}
                                    />
                                </div>
                            ))}
                        </div>
                        {dateScope === 'past' && onOpenSubmitEvent && (
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
                </OptionalPortal>
            )}
        </div>
    );
}
