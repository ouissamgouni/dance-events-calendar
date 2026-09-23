import { useEffect, useState } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';

interface ExploreSearchEntryProps {
    isSticky?: boolean;
}

export default function ExploreSearchEntry({ isSticky = false }: ExploreSearchEntryProps) {
    const navigate = useNavigate();
    const { browseDirectToExplorerEnabled } = useOptionalFeatureFlags();
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (isSticky) setExpanded(false);
    }, [isSticky]);

    if (!expanded) {
        return (
            <div className="flex justify-center">
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="inline-flex min-h-14 w-full max-w-md items-center justify-center gap-3 rounded-field border border-blue-200 bg-blue-50 px-5 py-3 text-base font-semibold text-action shadow-md transition hover:bg-blue-100"
                >
                    <Search className="h-5 w-5" aria-hidden="true" />
                    Start your search
                </button>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-md rounded-card bg-surface p-3 shadow-sm" data-testid="explore-search-expanded">
            <div className="grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-x-2">
                <button
                    type="button"
                    onClick={() => navigate(browseDirectToExplorerEnabled ? '/browse' : '/browse?sheet=1')}
                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-field bg-blue-50 px-4 py-2 text-sm font-semibold text-action hover:bg-blue-100"
                >
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                    Browse events
                </button>
                <button type="button" onClick={() => setExpanded(false)} aria-label="Collapse search" className="inline-flex h-11 w-11 items-center justify-center text-ink-soft hover:text-ink">
                    <X className="h-5 w-5" aria-hidden="true" />
                </button>
                <div className="col-start-1 py-2 text-center text-xs text-muted">or</div>
                <button
                    type="button"
                    onClick={() => navigate('/search', { state: { returnTo: '/' } })}
                    className="col-start-1 flex min-h-11 w-full items-center gap-2 rounded-field border border-line bg-canvas px-3 text-left text-sm text-muted"
                >
                    <Search className="h-4 w-4" aria-hidden="true" />
                    Search events, places, or tags…
                </button>
            </div>
        </div>
    );
}
