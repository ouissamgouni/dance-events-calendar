import { useState, type ReactNode } from 'react';

interface FindMorePanelProps {
    children: ReactNode;
    className?: string;
}

/**
 * Collapsible wrapper around the explorer's "Find more" surface — the
 * filter summary bar, trending trail, map, and event list. Reuses the
 * blue-50 header pattern from `ForYouRail` / `YourNextEventsRail` so
 * all three rails read as a consistent family.
 */
export default function FindMorePanel({ children, className = '' }: FindMorePanelProps) {
    const [collapsed, setCollapsed] = useState(false);
    return (
        <section
            className={`border border-blue-100 bg-white shadow-sm ${className}`}
            data-testid="find-more-panel"
        >
            <div className="flex w-full items-center gap-2 border-b border-blue-50 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 hover:text-blue-900 focus:outline-none"
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? 'Expand Find more' : 'Collapse Find more'}
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <img
                        src="/search.png"
                        alt=""
                        aria-hidden="true"
                        className="h-3.5 w-3.5 object-contain"
                    />
                    Find more
                </button>
                <button
                    type="button"
                    className="ml-auto shrink-0 text-xs text-slate-500 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-hidden="true"
                    tabIndex={-1}
                >
                    {collapsed ? '+' : '-'}
                </button>
            </div>
            {!collapsed && children}
        </section>
    );
}
