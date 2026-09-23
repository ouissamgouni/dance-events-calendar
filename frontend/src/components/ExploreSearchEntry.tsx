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
                    className="inline-flex min-h-11 w-full max-w-md items-center justify-center gap-2 rounded-field border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink shadow-sm hover:bg-canvas"
                >
                    <Search className="h-4 w-4 text-ink-soft" aria-hidden="true" />
                    Start your search
                </button>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-md rounded-card bg-surface p-3 shadow-sm" data-testid="explore-search-expanded">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => navigate('/search', { state: { returnTo: '/' } })}
                    className="flex min-h-11 flex-1 items-center gap-2 rounded-field border border-line bg-canvas px-3 text-left text-sm text-muted"
                >
                    <Search className="h-4 w-4" aria-hidden="true" />
                    Search events by name...
                </button>
                <button type="button" onClick={() => setExpanded(false)} aria-label="Collapse search" className="inline-flex h-11 w-11 items-center justify-center text-ink-soft hover:text-ink">
                    <X className="h-5 w-5" aria-hidden="true" />
                </button>
            </div>
            <div className="py-2 text-center text-xs text-muted">or</div>
            <button
                type="button"
                onClick={() => navigate(browseDirectToExplorerEnabled ? '/browse' : '/browse?sheet=1')}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-field bg-blue-50 px-4 py-2 text-sm font-semibold text-action hover:bg-blue-100"
            >
                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                Browse events
            </button>
        </div>
    );
}
