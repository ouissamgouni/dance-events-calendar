import { CalendarX, FilePlus, Globe, PencilLine, Trash2, type LucideIcon } from 'lucide-react';
import type { CalendarEvent, EventRevisionKind, RevisionChange } from '../types';

/** Per change kind: pill, row tint (one shade lighter), solid count badge and icon. */
export const CHANGE_KIND_META: Record<EventRevisionKind, { label: string; pill: string; row: string; badge: string; icon: LucideIcon }> = {
    create: { label: 'New event', pill: 'bg-blue-100 text-action', row: 'bg-blue-50', badge: 'bg-action', icon: FilePlus },
    go_public: { label: 'Go public', pill: 'bg-amber-100 text-amber-800', row: 'bg-amber-50', badge: 'bg-amber-500', icon: Globe },
    edit: { label: 'Edit', pill: 'bg-orange-100 text-orange-800', row: 'bg-orange-50', badge: 'bg-orange-500', icon: PencilLine },
    cancel: { label: 'Cancellation', pill: 'bg-red-100 text-danger', row: 'bg-red-50', badge: 'bg-danger', icon: CalendarX },
    remove: { label: 'Removal', pill: 'bg-slate-200 text-ink', row: 'bg-slate-100', badge: 'bg-slate-500', icon: Trash2 },
};

export const CHANGE_KINDS: EventRevisionKind[] = ['create', 'go_public', 'edit', 'cancel', 'remove'];

/** Fields an admin edit of a published event stages in a draft (mirrors backend DRAFT_FIELDS). */
export const DRAFT_FIELDS = [
    'title',
    'description',
    'location',
    'start',
    'end',
    'all_day',
    'links',
    'price_min',
    'price_max',
    'price_currency',
    'price_is_free',
    'latitude',
    'longitude',
    'timezone',
] as const;

const FIELD_LABELS: Record<string, string> = {
    title: 'Name',
    description: 'Description',
    location: 'Venue',
    start: 'Start',
    end: 'End',
    all_day: 'All day',
    links: 'Links',
    price_min: 'Min price',
    price_max: 'Max price',
    price_currency: 'Currency',
    price_is_free: 'Free',
    latitude: 'Latitude',
    longitude: 'Longitude',
    timezone: 'Time zone',
    recurrence_rule: 'Repeats',
    recurrence_dates: 'Dates',
    suggested_tag_ids: 'Tags',
    tag_ids: 'Tags',
    image_key: 'Picture',
    status: 'Status',
    status_reason: 'Why',
    is_cancelled: 'Cancelled',
    cancellation_note: 'Cancellation note',
    visibility: 'Audience',
};

const STATUS_REASON_LABELS: Record<string, string> = {
    admin: 'Removed by admin',
    duplicate: 'Duplicate',
    owner: 'Deleted by owner',
    google_calendar: 'Deleted in Google Calendar',
    series_edit: 'Dropped from series',
    rejected: 'Rejected',
};

export type StatusRequest = 'removal' | 'cancellation' | null;

/** Whether an open revision asks to remove or cancel the event. */
export function statusRequest(changes: Record<string, RevisionChange>): StatusRequest {
    if (changes.status?.new === 'removed') return 'removal';
    if (changes.is_cancelled?.new === true) return 'cancellation';
    return null;
}

/** Each date keeps its own time, so these only apply to the date they were made for. */
export function hasTimeChange(changes: Record<string, RevisionChange>): boolean {
    return ['start', 'end', 'all_day'].some((field) => field in changes);
}

export function revisionFieldLabel(field: string): string {
    return FIELD_LABELS[field] ?? field;
}

export function describeRevisionValue(field: string, value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (field === 'status_reason' && typeof value === 'string') return STATUS_REASON_LABELS[value] ?? value;
    if ((field === 'start' || field === 'end') && typeof value === 'string') {
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? value
            : date.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
    if (typeof value === 'object') return JSON.stringify(value);
    const text = String(value);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** Split side-panel edits into draft-staged fields and immediate ones. */
export function splitDraftChanges<T extends Record<string, unknown>>(changes: T): { draft: Partial<T>; immediate: Partial<T> } {
    const draft: Partial<T> = {};
    const immediate: Partial<T> = {};
    for (const [key, value] of Object.entries(changes) as [keyof T, T[keyof T]][]) {
        if ((DRAFT_FIELDS as readonly string[]).includes(key as string)) draft[key] = value;
        else immediate[key] = value;
    }
    return { draft, immediate };
}

/** The event as it will look once the draft is published. */
export function withDraft(event: CalendarEvent, changes: Record<string, RevisionChange> | null | undefined): CalendarEvent {
    if (!changes) return event;
    const overlay = Object.fromEntries(Object.entries(changes).map(([field, change]) => [field, change.new]));
    return { ...event, ...overlay } as CalendarEvent;
}
