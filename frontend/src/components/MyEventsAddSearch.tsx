import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { searchEvents, type EventSearchResult } from '../api';
import type { MyEventsTab } from '../utils/myEvents';
import GoingButton from './GoingButton';
import SaveEventButton from './SaveEventButton';

interface Props {
    tab: MyEventsTab;
    onSuggest: () => void;
}

export default function MyEventsAddSearch({ tab, onSuggest }: Props) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<EventSearchResult[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const term = query.trim();
        if (term.length < 2) {
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            setLoading(true);
            searchEvents(term, 12, tab === 'past', tab === 'past')
                .then((rows) => { if (!cancelled) setResults(rows); })
                .catch(() => { if (!cancelled) setResults([]); })
                .finally(() => { if (!cancelled) setLoading(false); });
        }, 250);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [query, tab]);

    const term = query.trim();
    return (
        <div className="fixed bottom-[calc(132px+env(safe-area-inset-bottom))] left-1/2 z-[7790] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-card border border-line bg-surface p-3 shadow-xl md:bottom-20" data-testid="my-events-add-search">
            <label className="flex items-center gap-2 border-b border-line pb-2">
                <Search className="h-4 w-4 text-muted" aria-hidden="true" />
                <span className="sr-only">Search events to add</span>
                <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={tab === 'past' ? 'Search past events' : 'Search upcoming events'}
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
                />
            </label>
            <div className="max-h-72 overflow-y-auto pt-2">
                {term.length < 2 && <p className="px-2 py-4 text-center text-xs text-ink-soft">Type at least 2 letters.</p>}
                {term.length >= 2 && loading && <p className="px-2 py-4 text-center text-xs text-ink-soft">Searching…</p>}
                {term.length >= 2 && !loading && results.length === 0 && (
                    <div className="px-2 py-4 text-center">
                        <p className="text-xs text-ink-soft">No matching events.</p>
                        <button type="button" onClick={onSuggest} className="mt-2 text-xs font-semibold text-action hover:underline">
                            Suggest an event
                        </button>
                    </div>
                )}
                {term.length >= 2 && results.map((result) => (
                    <div key={result.event_id} className="flex items-center gap-3 border-b border-card-line px-2 py-2 last:border-0">
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink">{result.title}</p>
                            <p className="truncate text-xs text-ink-soft">{[result.city, result.country].filter(Boolean).join(', ') || result.location}</p>
                        </div>
                        {tab === 'saved' ? (
                            <SaveEventButton eventId={result.event_id} appearance="icon" size="sm" />
                        ) : (
                            <GoingButton eventId={result.event_id} appearance="icon" size="sm" isPast={tab === 'past'} iconVariant="hand" />
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
