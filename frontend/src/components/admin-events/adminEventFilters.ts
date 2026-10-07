import type { AdminEventStatus, EventVisibilityState } from '../../types';
import type {
    AdminEventDiscount,
    AdminEventFlag,
    AdminEventGeoStatus,
    AdminEventHasKey,
    AdminEventPrice,
    AdminEventProgram,
    AdminEventReach,
    AdminEventSort,
    EventFilterOptionsResponse,
    EventFilterParams,
    FilterOption,
} from '../../api';

export interface AdminEventFilterState {
    status: AdminEventStatus[];
    audience: EventVisibilityState[];
    flags: AdminEventFlag[];
    price: AdminEventPrice[];
    discount: AdminEventDiscount[];
    program: AdminEventProgram[];
    reach: AdminEventReach[];
    geo: AdminEventGeoStatus | '';
    calendar: string;
    tag: string;
    goingMin: number | null;
    savedMin: number | null;
    engagedMin: number | null;
    dateMode: 'upcoming' | 'all' | 'range';
    startFrom: string;
    startTo: string;
    has: Partial<Record<AdminEventHasKey, boolean>>;
}

export const DEFAULT_FILTERS: AdminEventFilterState = {
    status: [],
    audience: [],
    flags: [],
    price: [],
    discount: [],
    program: [],
    reach: [],
    geo: '',
    calendar: '',
    tag: '',
    goingMin: null,
    savedMin: null,
    engagedMin: null,
    dateMode: 'upcoming',
    startFrom: '',
    startTo: '',
    has: {},
};

export type MultiKey = 'status' | 'audience' | 'flags' | 'price' | 'discount' | 'program' | 'reach';
export type SingleKey = 'geo' | 'calendar' | 'tag';
export type MinKey = 'goingMin' | 'savedMin' | 'engagedMin';
export type FilterGroup = 'Moderation' | 'Data quality' | 'Commerce' | 'Engagement' | 'Schedule';
type OptionsKey = 'calendars' | 'audiences' | 'statuses' | 'flags' | 'geo_statuses' | 'tags' | 'prices' | 'discounts' | 'programs' | 'reaches';

export type FilterDimension = { label: string; group: FilterGroup } & (
    | { id: MultiKey; kind: 'multi'; optionsKey: OptionsKey }
    | { id: SingleKey; kind: 'single'; optionsKey: OptionsKey; anyLabel: string }
    | { id: MinKey; kind: 'min' }
    | { id: AdminEventHasKey; kind: 'bool'; yes: string; no: string }
    | { id: 'dates'; kind: 'dates' }
);

export const FILTER_GROUPS: FilterGroup[] = ['Moderation', 'Schedule', 'Engagement', 'Commerce', 'Data quality'];

export const FILTER_DIMENSIONS: FilterDimension[] = [
    { id: 'status', kind: 'multi', label: 'Status', group: 'Moderation', optionsKey: 'statuses' },
    { id: 'audience', kind: 'multi', label: 'Audience', group: 'Moderation', optionsKey: 'audiences' },
    { id: 'flags', kind: 'multi', label: 'Flags', group: 'Moderation', optionsKey: 'flags' },
    { id: 'dates', kind: 'dates', label: 'Dates', group: 'Schedule' },
    { id: 'program', kind: 'multi', label: 'Program', group: 'Schedule', optionsKey: 'programs' },
    { id: 'in_series', kind: 'bool', label: 'Series', group: 'Schedule', yes: 'In a series', no: 'Not in a series' },
    { id: 'goingMin', kind: 'min', label: 'Going', group: 'Engagement' },
    { id: 'savedMin', kind: 'min', label: 'Saved', group: 'Engagement' },
    { id: 'engagedMin', kind: 'min', label: 'Engaged (going or saved)', group: 'Engagement' },
    { id: 'has_ratings', kind: 'bool', label: 'Ratings', group: 'Engagement', yes: 'Has ratings', no: 'No ratings' },
    { id: 'has_messages', kind: 'bool', label: 'Messages', group: 'Engagement', yes: 'Has messages', no: 'No messages' },
    { id: 'has_memories', kind: 'bool', label: 'Memories', group: 'Engagement', yes: 'Has memories', no: 'No memories' },
    { id: 'price', kind: 'multi', label: 'Price', group: 'Commerce', optionsKey: 'prices' },
    { id: 'discount', kind: 'multi', label: 'Discount', group: 'Commerce', optionsKey: 'discounts' },
    { id: 'calendar', kind: 'single', label: 'Calendar', group: 'Data quality', optionsKey: 'calendars', anyLabel: 'All calendars' },
    { id: 'tag', kind: 'single', label: 'Tag', group: 'Data quality', optionsKey: 'tags', anyLabel: 'All tags' },
    { id: 'has_tags', kind: 'bool', label: 'Tagged', group: 'Data quality', yes: 'Tagged', no: 'Untagged' },
    { id: 'geo', kind: 'single', label: 'Location', group: 'Data quality', optionsKey: 'geo_statuses', anyLabel: 'Any location' },
    { id: 'reach', kind: 'multi', label: 'Reach', group: 'Data quality', optionsKey: 'reaches' },
    { id: 'has_image', kind: 'bool', label: 'Image', group: 'Data quality', yes: 'Has image', no: 'No image' },
    { id: 'has_links', kind: 'bool', label: 'Links', group: 'Data quality', yes: 'Has links', no: 'No links' },
    { id: 'has_organizer', kind: 'bool', label: 'Organizer', group: 'Data quality', yes: 'Verified organizer', no: 'No organizer' },
];

export function dimensionOptions(dim: FilterDimension, options: EventFilterOptionsResponse | null): FilterOption[] {
    return 'optionsKey' in dim ? options?.[dim.optionsKey] ?? [] : [];
}

export function isDimensionActive(dim: FilterDimension, state: AdminEventFilterState): boolean {
    switch (dim.kind) {
        case 'multi': return state[dim.id].length > 0;
        case 'single': return state[dim.id] !== '';
        case 'min': return state[dim.id] != null;
        case 'bool': return state.has[dim.id] != null;
        case 'dates': return state.dateMode !== 'upcoming';
    }
}

export function clearDimension(dim: FilterDimension, state: AdminEventFilterState): AdminEventFilterState {
    switch (dim.kind) {
        case 'multi': return { ...state, [dim.id]: [] };
        case 'single': return { ...state, [dim.id]: '' };
        case 'min': return { ...state, [dim.id]: null };
        case 'bool': {
            const has = { ...state.has };
            delete has[dim.id];
            return { ...state, has };
        }
        case 'dates': return { ...state, dateMode: 'upcoming', startFrom: '', startTo: '' };
    }
}

const labelOf = (options: FilterOption[], value: string) => options.find((o) => o.value === value)?.label ?? value;

export function dimensionSummary(
    dim: FilterDimension,
    state: AdminEventFilterState,
    options: EventFilterOptionsResponse | null,
): string {
    switch (dim.kind) {
        case 'multi': {
            const opts = dimensionOptions(dim, options);
            return `${dim.label}: ${state[dim.id].map((v) => labelOf(opts, v)).join(', ')}`;
        }
        case 'single':
            return `${dim.label}: ${labelOf(dimensionOptions(dim, options), state[dim.id])}`;
        case 'min':
            return `${dim.label} ≥ ${state[dim.id]}`;
        case 'bool':
            return state.has[dim.id] ? dim.yes : dim.no;
        case 'dates':
            if (state.dateMode === 'all') return 'All dates';
            if (state.dateMode === 'upcoming') return 'Upcoming';
            if (state.startFrom && state.startTo) return `${state.startFrom} – ${state.startTo}`;
            return state.startFrom ? `From ${state.startFrom}` : state.startTo ? `Until ${state.startTo}` : 'Any date';
    }
}

export function activeDimensions(state: AdminEventFilterState): FilterDimension[] {
    return FILTER_DIMENSIONS.filter((dim) => isDimensionActive(dim, state));
}

const PARAM_KEY: Partial<Record<FilterDimension['id'], string>> = {
    geo: 'geo_status',
    calendar: 'calendar_id',
    tag: 'tag_ids',
    goingMin: 'going_min',
    savedMin: 'saved_min',
    engagedMin: 'engaged_min',
};

/** Events matching this active filter alone (with search + dates). */
export function dimensionCount(dim: FilterDimension, options: EventFilterOptionsResponse | null): number | undefined {
    return options?.dimension_counts?.[PARAM_KEY[dim.id] ?? dim.id];
}

/** Events with the switch on (bool) or at least one (min), for the "+ Filter" list. */
export function dimensionPresenceCount(dim: FilterDimension, options: EventFilterOptionsResponse | null): number | undefined {
    if (dim.kind === 'bool') return options?.has_counts?.[dim.id]?.yes;
    if (dim.kind === 'min') return options?.min_counts?.[PARAM_KEY[dim.id] as 'going_min' | 'saved_min' | 'engaged_min'];
    return undefined;
}

export function toFilterParams(state: AdminEventFilterState): EventFilterParams {
    const range = state.dateMode === 'range';
    return {
        status: state.status,
        audience: state.audience,
        flags: state.flags,
        price: state.price,
        discount: state.discount,
        program: state.program,
        reach: state.reach,
        geo_status: state.geo || undefined,
        calendar_id: state.calendar || undefined,
        tag_ids: state.tag || undefined,
        going_min: state.goingMin ?? undefined,
        saved_min: state.savedMin ?? undefined,
        engaged_min: state.engagedMin ?? undefined,
        include_past: state.dateMode === 'all' || undefined,
        start_from: (range && state.startFrom) || undefined,
        start_to: (range && state.startTo) || undefined,
        has: state.has,
    };
}

export interface QuickView {
    id: string;
    label: string;
    filters: Partial<AdminEventFilterState>;
}

export const QUICK_VIEWS: QuickView[] = [
    { id: 'all', label: 'All', filters: {} },
    { id: 'review', label: 'Needs review', filters: { status: ['new'] } },
    { id: 'changes', label: 'Pending changes', filters: { flags: ['changes'] } },
    { id: 'public', label: 'Public requests', filters: { flags: ['wants_public'] } },
    { id: 'geo', label: 'Missing location', filters: { geo: 'ungeolocated' } },
    { id: 'untagged', label: 'Untagged', filters: { has: { has_tags: false } } },
];

const paramsKey = (state: AdminEventFilterState) => JSON.stringify(toFilterParams(state));

export function matchQuickView(state: AdminEventFilterState, views: QuickView[] = QUICK_VIEWS): string | null {
    const key = paramsKey(state);
    return views.find((view) => paramsKey({ ...DEFAULT_FILTERS, ...view.filters }) === key)?.id ?? null;
}

const PRESETS_KEY = 'admin:events-presets:v1';

/** Admin-saved quick views, kept in this browser. */
export function loadCustomPresets(): QuickView[] {
    try {
        const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]') as unknown;
        if (!Array.isArray(raw)) return [];
        return raw.filter((p): p is QuickView =>
            Boolean(p) && typeof p.id === 'string' && typeof p.label === 'string' && typeof p.filters === 'object' && p.filters !== null);
    } catch {
        return [];
    }
}

export function saveCustomPresets(presets: QuickView[]): void {
    try {
        localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    } catch {
        // Storage full or disabled: presets just won't persist.
    }
}

export function presetFrom(label: string, state: AdminEventFilterState): QuickView {
    return { id: `custom-${Date.now().toString(36)}`, label, filters: state };
}

export type SortOrder = 'asc' | 'desc';

export const defaultSortOrder = (key: AdminEventSort): SortOrder => (key === 'start' || key === 'title' ? 'asc' : 'desc');

/** Header click cycle: default direction, then reversed, then back to date order. */
export function nextSort(current: AdminEventSort, order: SortOrder, clicked: AdminEventSort): [AdminEventSort, SortOrder] {
    const fallback = defaultSortOrder(clicked);
    if (current !== clicked) return [clicked, fallback];
    if (order === fallback) return [clicked, fallback === 'asc' ? 'desc' : 'asc'];
    return ['start', 'asc'];
}

export const SORT_OPTIONS: { value: AdminEventSort; label: string }[] = [
    { value: 'start', label: 'Date' },
    { value: 'added', label: 'Added' },
    { value: 'submitted', label: 'Submitted' },
    { value: 'title', label: 'Title' },
    { value: 'going', label: 'Going' },
    { value: 'saved', label: 'Saved' },
    { value: 'engaged', label: 'Engaged' },
    { value: 'views', label: 'Views' },
    { value: 'clicks', label: 'Clicks' },
    { value: 'ratings', label: 'Ratings' },
    { value: 'messages', label: 'Messages' },
    { value: 'memories', label: 'Memories' },
    { value: 'price', label: 'Price' },
];
