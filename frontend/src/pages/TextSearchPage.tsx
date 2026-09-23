import { useEffect, useState } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchEventsByIds, searchEventsPage, type EventSearchResult } from '../api';
import type { CalendarEvent } from '../types';
import SearchEventCard from '../components/SearchEventCard';

const PREVIEW_LIMIT = 3;
const PAGE_SIZE = 20;

interface TextSearchLocationState {
    returnTo?: unknown;
}

function searchReturnTo(state: unknown): string {
    const candidate = (state as TextSearchLocationState | null)?.returnTo;
    return typeof candidate === 'string'
        && candidate.startsWith('/')
        && !candidate.startsWith('//')
        && !candidate.startsWith('/search')
        ? candidate
        : '/';
}

export default function TextSearchPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const [params, setParams] = useSearchParams();
    const fullResults = location.pathname.endsWith('/results');
    const returnTo = searchReturnTo(location.state);
    const query = params.get('q') ?? '';
    const [input, setInput] = useState(query);
    const [results, setResults] = useState<EventSearchResult[]>([]);
    const [eventsById, setEventsById] = useState<Map<string, CalendarEvent>>(new Map());
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);

    useEffect(() => setInput(query), [query]);
    useEffect(() => {
        const normalized = input.trim();
        if (normalized === query) return;
        const timer = window.setTimeout(() => {
            const nextParams: Record<string, string> = normalized.length >= 2 ? { q: normalized } : {};
            if (fullResults) {
                const search = normalized.length >= 2 ? `?q=${encodeURIComponent(normalized)}` : '';
                navigate({ pathname: '/search', search }, { replace: true, state: { returnTo } });
            } else {
                setParams(nextParams, { replace: true, state: { returnTo } });
            }
        }, 250);
        return () => window.clearTimeout(timer);
    }, [fullResults, input, navigate, query, returnTo, setParams]);
    useEffect(() => {
        if (query.length < 2) {
            setResults([]);
            setEventsById(new Map());
            setTotal(0);
            setHasMore(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        searchEventsPage(query, fullResults ? PAGE_SIZE : PREVIEW_LIMIT)
            .then(async (page) => {
                if (cancelled) return;
                const events = await fetchEventsByIds(page.results.map((result) => result.event_id)).catch(() => []);
                if (cancelled) return;
                setResults(page.results);
                setEventsById(new Map(events.map((event) => [event.event_id, event])));
                setTotal(page.total);
                setHasMore(page.hasMore);
            })
            .catch(() => {
                if (!cancelled) setResults([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [fullResults, query]);

    const loadMore = async () => {
        setLoading(true);
        try {
            const page = await searchEventsPage(query, PAGE_SIZE, results.length);
            const events = await fetchEventsByIds(page.results.map((result) => result.event_id)).catch(() => []);
            setResults((current) => [...current, ...page.results]);
            setEventsById((current) => {
                const next = new Map(current);
                events.forEach((event) => next.set(event.event_id, event));
                return next;
            });
            setHasMore(page.hasMore);
            setTotal(page.total);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-full bg-canvas">
            <div className="mx-auto max-w-2xl">
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface p-3">
                    <button type="button" onClick={() => navigate(returnTo, { replace: true })} aria-label="Back" className="inline-flex h-11 w-11 items-center justify-center text-ink-soft"><ArrowLeft className="h-5 w-5" /></button>
                    <label className="flex min-h-11 flex-1 items-center gap-2 rounded-field bg-canvas px-3">
                        <Search className="h-4 w-4 text-muted" aria-hidden="true" />
                        <span className="sr-only">Search events by name</span>
                        <input autoFocus type="text" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Search events by name..." className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none" />
                        {input && <button type="button" onClick={() => setInput('')} aria-label="Clear search"><X className="h-4 w-4 text-muted" /></button>}
                    </label>
                </div>
                <div className="px-3 py-3">
                    {query.length < 2 && <p className="text-sm text-ink-soft">Type at least 2 letters to find a specific event.</p>}
                    {loading && results.length === 0 && <p className="text-sm text-ink-soft">Searching...</p>}
                    {!loading && query.length >= 2 && results.length === 0 && <p className="text-sm text-ink-soft">No events match “{query}”.</p>}
                    {results.length > 0 && (
                        <>
                            <p className="mb-2 text-xs font-semibold text-ink-soft">{total} matching event{total === 1 ? '' : 's'}</p>
                            <div className="space-y-2">{results.map((result) => (
                                <SearchEventCard
                                    key={result.event_id}
                                    result={result}
                                    event={eventsById.get(result.event_id)}
                                    onOpen={() => navigate(`/event/${result.event_id}?src=text-search`)}
                                    testId="text-search-event-card"
                                />
                            ))}</div>
                            {!fullResults && <Link replace to={`/search/results?q=${encodeURIComponent(query)}`} state={{ returnTo }} className="mt-3 flex min-h-11 w-full items-center justify-center rounded-field bg-action px-4 text-sm font-semibold text-white">Show all {total} matching events</Link>}
                            {fullResults && hasMore && <button type="button" onClick={loadMore} disabled={loading} className="mt-3 min-h-11 w-full rounded-field border border-line bg-surface text-sm font-semibold text-action disabled:opacity-50">{loading ? 'Loading...' : 'Show more'}</button>}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
