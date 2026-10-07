import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Plus, Search, X } from 'lucide-react';
import type { AdminEventSort, EventFilterOptionsResponse } from '../../api';
import AdminPopover from './AdminPopover';
import FilterEditor from './FilterEditor';
import {
    DEFAULT_FILTERS,
    FILTER_DIMENSIONS,
    FILTER_GROUPS,
    QUICK_VIEWS,
    SORT_OPTIONS,
    activeDimensions,
    clearDimension,
    defaultSortOrder,
    dimensionCount,
    dimensionPresenceCount,
    dimensionSummary,
    isDimensionActive,
    matchQuickView,
    type AdminEventFilterState,
    type FilterDimension,
    type SortOrder,
} from './adminEventFilters';

interface Props {
    search: string;
    onSearchChange: (value: string) => void;
    filters: AdminEventFilterState;
    onFiltersChange: (next: AdminEventFilterState) => void;
    options: EventFilterOptionsResponse | null;
    sort: AdminEventSort;
    order: SortOrder;
    onSort: (sort: AdminEventSort, order: SortOrder) => void;
    groupBySeries: boolean;
    onToggleGroupBySeries: () => void;
    columnsMenu: ReactNode;
    /** Dimension ids hidden by the panel preset. */
    hiddenDimensions?: string[];
}

const toolbarButton = 'inline-flex items-center gap-1.5 border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink hover:bg-canvas';

function FilterChip({ dim, filters, options, onFiltersChange, removable }: {
    dim: FilterDimension;
    filters: AdminEventFilterState;
    options: EventFilterOptionsResponse | null;
    onFiltersChange: (next: AdminEventFilterState) => void;
    removable: boolean;
}) {
    const [open, setOpen] = useState(false);
    const summary = dimensionSummary(dim, filters, options);
    const count = dimensionCount(dim, options);
    return (
        <div className="relative">
            <div className="inline-flex items-center border border-action bg-blue-50 text-[11px] font-medium text-action">
                <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label={`Edit filter: ${summary}`}
                    onClick={() => setOpen((v) => !v)}
                    className="inline-flex max-w-[260px] items-center gap-1 px-2 py-0.5 hover:underline"
                >
                    <span className="truncate">{summary}</span>
                    {count != null && <span className="font-normal tabular-nums text-action/70" title="Events matching this filter alone">{count}</span>}
                </button>
                {removable && (
                    <button
                        type="button"
                        aria-label={`Remove filter ${dim.label}`}
                        onClick={() => onFiltersChange(clearDimension(dim, filters))}
                        className="border-l border-blue-200 px-1 py-0.5 hover:bg-blue-100"
                    >
                        <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                )}
            </div>
            <AdminPopover open={open} onClose={() => setOpen(false)} label={`${dim.label} filter`} className="w-72">
                <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-ink-soft">{dim.label}</p>
                <FilterEditor dim={dim} state={filters} options={options} onChange={onFiltersChange} />
            </AdminPopover>
        </div>
    );
}

export default function AdminEventsToolbar({
    search, onSearchChange, filters, onFiltersChange, options, sort, order, onSort,
    groupBySeries, onToggleGroupBySeries, columnsMenu, hiddenDimensions = [],
}: Props) {
    const searchRef = useRef<HTMLInputElement>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [addDimId, setAddDimId] = useState<string | null>(null);
    const [dimQuery, setDimQuery] = useState('');
    const dimensions = FILTER_DIMENSIONS.filter((d) => !hiddenDimensions.includes(d.id));
    const active = activeDimensions(filters).filter((d) => d.id !== 'dates' && !hiddenDimensions.includes(d.id));
    const addDim = dimensions.find((d) => d.id === addDimId) ?? null;
    const quickView = matchQuickView(filters);
    const datesDim = FILTER_DIMENSIONS.find((d) => d.id === 'dates')!;

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
            if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
            e.preventDefault();
            searchRef.current?.focus();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    const closeAdd = () => {
        setAddOpen(false);
        setAddDimId(null);
        setDimQuery('');
    };
    const matchingDims = dimensions.filter((d) => d.label.toLowerCase().includes(dimQuery.toLowerCase()));

    const addFilter = (
        <div className="relative">
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={addOpen}
                onClick={() => (addOpen ? closeAdd() : setAddOpen(true))}
                className={toolbarButton}
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Filter
            </button>
            <AdminPopover open={addOpen} onClose={closeAdd} label={addDim ? `${addDim.label} filter` : 'Add filter'} className="w-72">
                {addDim ? (
                    <>
                        <button type="button" onClick={() => setAddDimId(null)} className="mb-1 inline-flex items-center gap-1 px-1 text-[11px] font-medium text-ink-soft hover:text-action">
                            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
                            {addDim.label}
                        </button>
                        <FilterEditor dim={addDim} state={filters} options={options} onChange={onFiltersChange} />
                    </>
                ) : (
                    <>
                        <input
                            type="search"
                            autoFocus
                            value={dimQuery}
                            onChange={(e) => setDimQuery(e.target.value)}
                            placeholder="Filter by…"
                            aria-label="Find a filter"
                            className="mb-1 w-full border border-line px-2 py-1 text-xs text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                        />
                        <div className="max-h-80 overflow-y-auto">
                            {FILTER_GROUPS.map((group) => {
                                const dims = matchingDims.filter((d) => d.group === group);
                                if (dims.length === 0) return null;
                                return (
                                    <div key={group} className="py-1">
                                        <p className="px-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{group}</p>
                                        {dims.map((dim) => (
                                            <button
                                                key={dim.id}
                                                type="button"
                                                onClick={() => setAddDimId(dim.id)}
                                                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-ink hover:bg-canvas"
                                            >
                                                <span className="flex-1">{dim.label}</span>
                                                {dimensionPresenceCount(dim, options) != null && (
                                                    <span className="tabular-nums text-muted" title={dim.kind === 'bool' ? dim.yes : 'At least one'}>{dimensionPresenceCount(dim, options)}</span>
                                                )}
                                                {isDimensionActive(dim, filters) && (
                                                    // eslint-disable-next-line no-restricted-syntax -- active indicator dot
                                                    <span className="h-1.5 w-1.5 rounded-full bg-action" aria-label="active" />
                                                )}
                                                <ChevronRight className="h-3 w-3 text-muted" aria-hidden="true" />
                                            </button>
                                        ))}
                                    </div>
                                );
                            })}
                            {matchingDims.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">No matching filter.</p>}
                        </div>
                    </>
                )}
            </AdminPopover>
        </div>
    );

    return (
        <div className="shrink-0 space-y-2 border-b border-card-line px-4 py-2">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-64">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
                    <input
                        ref={searchRef}
                        type="text"
                        value={search}
                        onChange={(e) => onSearchChange(e.target.value)}
                        placeholder="Search events…  ( / )"
                        title="Searches title, description, location and links"
                        aria-label="Search events"
                        className="w-full border border-line py-1.5 pl-7 pr-7 text-[11px] text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
                    />
                    {search && (
                        <button type="button" onClick={() => onSearchChange('')} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted hover:text-ink">
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    )}
                </div>

                <div className="ml-auto flex flex-wrap items-center gap-2">
                    <div className="inline-flex items-center border border-line bg-surface">
                        <label className="flex items-center gap-1 pl-2 text-[11px] text-ink-soft">
                            Sort
                            <select
                                value={sort}
                                onChange={(e) => {
                                    const value = e.target.value as AdminEventSort;
                                    onSort(value, defaultSortOrder(value));
                                }}
                                aria-label="Sort by"
                                className="bg-transparent py-1 pr-1 text-[11px] font-medium text-ink focus:outline-none"
                            >
                                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </label>
                        <button
                            type="button"
                            onClick={() => onSort(sort, order === 'asc' ? 'desc' : 'asc')}
                            aria-label={order === 'asc' ? 'Sorted ascending, switch to descending' : 'Sorted descending, switch to ascending'}
                            className="border-l border-line px-1.5 py-1 text-ink-soft hover:text-action"
                        >
                            {order === 'asc' ? <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                    </div>

                    <button
                        type="button"
                        aria-pressed={groupBySeries}
                        onClick={onToggleGroupBySeries}
                        title="One row per series"
                        className={`${toolbarButton} ${groupBySeries ? 'border-action bg-blue-50 text-action' : ''}`}
                    >
                        Group by series
                    </button>
                    {columnsMenu}
                </div>
            </div>

            <div role="group" aria-label="Quick views" className="flex flex-wrap items-center gap-1">
                {QUICK_VIEWS.filter((view) => !Object.keys(view.filters).some((key) => hiddenDimensions.includes(key))).map((view) => {
                    const selected = quickView === view.id;
                    const count = options?.quick_views?.[view.id];
                    return (
                        <button
                            key={view.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => onFiltersChange({ ...DEFAULT_FILTERS, ...view.filters })}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium transition ${selected ? 'bg-action text-white' : 'text-ink-soft hover:bg-canvas hover:text-ink'}`}
                        >
                            {view.label}
                            {count != null && <span className={`font-normal tabular-nums ${selected ? 'text-white/80' : 'text-muted'}`}>{count}</span>}
                        </button>
                    );
                })}
                <span aria-hidden="true" className="mx-1 h-4 w-px bg-line" />
                {addFilter}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                <FilterChip dim={datesDim} filters={filters} options={options} onFiltersChange={onFiltersChange} removable={isDimensionActive(datesDim, filters)} />
                {active.map((dim) => (
                    <FilterChip key={dim.id} dim={dim} filters={filters} options={options} onFiltersChange={onFiltersChange} removable />
                ))}
                {(active.length > 0 || isDimensionActive(datesDim, filters)) && (
                    <button type="button" onClick={() => onFiltersChange(DEFAULT_FILTERS)} className="px-1 text-[11px] font-medium text-action hover:underline">
                        Clear all
                    </button>
                )}
            </div>
        </div>
    );
}
