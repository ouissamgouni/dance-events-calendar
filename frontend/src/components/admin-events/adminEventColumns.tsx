import {
    columnOrderingFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    createColumnHelper,
    tableFeatures,
} from '@tanstack/react-table';
import { Repeat } from 'lucide-react';
import type { AdminEventSort } from '../../api';
import type { CalendarEvent } from '../../types';
import LocationBadge from '../LocationBadge';
import { EventFlagIcons, MatchesCell } from './AdminEventCells';
import {
    ADMIN_EVENT_STATUS_CHIP_CLASSES,
    ADMIN_EVENT_STATUS_LABELS,
    getAdminEventStatus,
    getAdminEventStatusIcon,
    getRemovalReasonLabel,
    reviewLockReason,
} from '../../utils/adminEventStatus';
import { formatCompactDateRange } from '../../utils/eventDates';
import { formatEventPrice } from '../../utils/eventPrice';

export interface AdminColumnMeta {
    label: string;
    sortKey?: AdminEventSort;
    align?: 'left' | 'right' | 'center';
    defaultHidden?: boolean;
    /** Pinned columns can't be hidden, moved or resized. */
    pinned?: boolean;
    /** Renders `header` instead of the label (TanStack supplies a null default header). */
    customHeader?: boolean;
    title?: string;
}

export const adminTableFeatures = tableFeatures({
    columnVisibilityFeature,
    columnOrderingFeature,
    columnSizingFeature,
    columnResizingFeature,
    columnMeta: {} as AdminColumnMeta,
});

export interface AdminColumnContext {
    selectedIds: Set<string>;
    allPageSelected: boolean;
    onSelectAll: () => void;
    onToggleSelect: (eventId: string) => void;
    onReview: (eventId: string) => void;
    calendarLabel: (calendarId: string) => string;
}

const ENGAGEMENT_TOOLTIP = 'Visitors who accepted analytics cookies only; admins excluded.';
const helper = createColumnHelper<typeof adminTableFeatures, CalendarEvent>();
const dash = <span className="text-muted">—</span>;
const count = (value: number | null | undefined) => <span className="tabular-nums text-ink-soft">{value ?? 0}</span>;

export function buildAdminEventColumns(ctx: AdminColumnContext) {
    return [
        helper.display({
            id: 'select',
            size: 32,
            enableHiding: false,
            enableResizing: false,
            meta: { label: 'Select', pinned: true, customHeader: true },
            header: () => (
                <input type="checkbox" aria-label="Select page" checked={ctx.allPageSelected} onChange={ctx.onSelectAll} className="h-3 w-3" />
            ),
            cell: ({ row }) => (
                <input
                    type="checkbox"
                    aria-label={`Select ${row.original.title}`}
                    checked={ctx.selectedIds.has(row.original.event_id)}
                    onChange={() => ctx.onToggleSelect(row.original.event_id)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-3 w-3"
                />
            ),
        }),
        helper.display({
            id: 'title',
            size: 280,
            minSize: 160,
            enableHiding: false,
            meta: { label: 'Title', sortKey: 'title', pinned: true },
            cell: ({ row: { original: event } }) => (
                <>
                    <div className="flex min-w-0 items-center gap-1.5">
                        {event.color && (
                            // eslint-disable-next-line no-restricted-syntax -- calendar colour dot
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: event.color }} />
                        )}
                        {(event.in_series || (event.occurrence_count ?? 1) > 1) && (
                            <Repeat className="h-3 w-3 shrink-0 text-ink-soft" aria-label="Series" role="img" />
                        )}
                        <span className={`truncate font-medium ${getAdminEventStatus(event) === 'cancelled' ? 'text-ink-soft line-through' : 'text-ink'}`}>
                            {event.title}
                        </span>
                    </div>
                    {event.location && <p className="mt-0.5 truncate text-[10px] text-muted">{event.location}</p>}
                </>
            ),
        }),
        helper.display({
            id: 'date',
            size: 140,
            meta: { label: 'Date', sortKey: 'start' },
            cell: ({ row: { original: event } }) => (
                <span className="whitespace-nowrap text-ink-soft">
                    {formatCompactDateRange(event)}
                    {(event.occurrence_count ?? 1) > 1 && (
                        <span className="ml-1 text-muted" title={`${event.occurrence_count} dates in this series`}>×{event.occurrence_count}</span>
                    )}
                </span>
            ),
        }),
        helper.display({
            id: 'submitter',
            size: 120,
            meta: { label: 'Submitter', defaultHidden: true },
            cell: ({ row: { original: event } }) => (
                <span className="block truncate text-ink-soft" title={event.submitter_name ?? undefined}>{event.submitter_name ?? dash}</span>
            ),
        }),
        helper.display({
            id: 'added',
            size: 130,
            meta: { label: 'Added', sortKey: 'added', defaultHidden: true },
            cell: ({ row: { original: event } }) => event.created_at
                ? (
                    <span className="whitespace-nowrap text-ink-soft" title={new Date(event.created_at).toLocaleString()}>
                        {new Date(event.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                )
                : dash,
        }),
        helper.display({
            id: 'submitted',
            size: 110,
            meta: { label: 'Submitted', sortKey: 'submitted', defaultHidden: true },
            cell: ({ row: { original: event } }) => event.submitted_at
                ? <span className="whitespace-nowrap text-ink-soft">{new Date(event.submitted_at).toLocaleDateString()}</span>
                : dash,
        }),
        helper.display({
            id: 'image',
            size: 64,
            meta: { label: 'Image' },
            cell: ({ row: { original: event } }) => (event.image_thumb_url ?? event.image_url) ? (
                <img
                    src={event.image_thumb_url ?? event.image_url ?? undefined}
                    alt=""
                    loading="lazy"
                    className="aspect-video w-12 object-cover"
                    onError={(error) => { error.currentTarget.hidden = true; }}
                />
            ) : null,
        }),
        helper.display({
            id: 'status',
            size: 110,
            meta: { label: 'Status' },
            cell: ({ row: { original: event } }) => {
                const status = getAdminEventStatus(event);
                const icon = getAdminEventStatusIcon(event);
                const reason = getRemovalReasonLabel(event);
                return (
                    <div className="flex flex-wrap items-center gap-1">
                        {icon && <img src={icon} alt="" aria-hidden="true" className="h-4 w-4 shrink-0 object-contain" />}
                        <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium ${ADMIN_EVENT_STATUS_CHIP_CLASSES[status]}`}>
                            {ADMIN_EVENT_STATUS_LABELS[status]}
                        </span>
                        {reason && (
                            <span className="inline-block bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-soft" title={event.block_reason_detail ?? undefined}>
                                {reason}
                            </span>
                        )}
                    </div>
                );
            },
        }),
        helper.display({
            id: 'flags',
            size: 80,
            meta: { label: 'Flags' },
            cell: ({ row }) => <EventFlagIcons event={row.original} />,
        }),
        helper.display({
            id: 'geo',
            size: 48,
            meta: { label: 'Geo', align: 'center' },
            cell: ({ row: { original: event } }) => (
                <LocationBadge location={event.location} latitude={event.latitude} longitude={event.longitude} size="sm" />
            ),
        }),
        helper.display({
            id: 'tags',
            size: 120,
            meta: { label: 'Tags' },
            cell: ({ row: { original: event } }) => (
                <div className="flex flex-wrap gap-0.5">
                    {event.tags.slice(0, 2).map((t) => (
                        <span key={t.id} className="max-w-[60px] truncate bg-gray-100 px-1 py-0 text-[9px] text-ink-soft">{t.label}</span>
                    ))}
                    {event.tags.length > 2 && <span className="text-[9px] text-muted">+{event.tags.length - 2}</span>}
                </div>
            ),
        }),
        helper.display({
            id: 'calendar',
            size: 120,
            meta: { label: 'Calendar', defaultHidden: true },
            cell: ({ row: { original: event } }) => (
                <span className="block truncate text-ink-soft">{ctx.calendarLabel(event.calendar_id)}</span>
            ),
        }),
        helper.display({
            id: 'reach',
            size: 90,
            meta: { label: 'Reach', defaultHidden: true },
            cell: ({ row: { original: event } }) => event.reach ? <span className="capitalize text-ink-soft">{event.reach}</span> : dash,
        }),
        helper.display({
            id: 'matches',
            size: 80,
            meta: { label: 'Matches', title: 'Users whose saved searches match: notified / matching' },
            cell: ({ row }) => <MatchesCell reach={row.original.interest_reach} />,
        }),
        helper.display({
            id: 'views',
            size: 64,
            meta: { label: 'Views', sortKey: 'views', align: 'right', title: ENGAGEMENT_TOOLTIP },
            cell: ({ row: { original: event } }) => (
                <span className="tabular-nums text-ink-soft" title={`${event.unique_viewers ?? 0} unique viewers`}>{event.view_count ?? 0}</span>
            ),
        }),
        helper.display({
            id: 'clicks',
            size: 64,
            meta: { label: 'Clicks', sortKey: 'clicks', align: 'right', title: ENGAGEMENT_TOOLTIP },
            cell: ({ row }) => count(row.original.link_clicks),
        }),
        helper.display({
            id: 'going',
            size: 64,
            meta: { label: 'Going', sortKey: 'going', align: 'right' },
            cell: ({ row }) => count(row.original.going_count),
        }),
        helper.display({
            id: 'saved',
            size: 64,
            meta: { label: 'Saved', sortKey: 'saved', align: 'right' },
            cell: ({ row }) => count(row.original.saved_count),
        }),
        helper.display({
            id: 'engaged',
            size: 72,
            meta: { label: 'Engaged', sortKey: 'engaged', align: 'right', defaultHidden: true, title: 'Distinct devices going or saved' },
            cell: ({ row }) => count(row.original.engaged_count),
        }),
        helper.display({
            id: 'ratings',
            size: 64,
            meta: { label: 'Ratings', sortKey: 'ratings', align: 'right', defaultHidden: true },
            cell: ({ row }) => count(row.original.rating_count),
        }),
        helper.display({
            id: 'messages',
            size: 72,
            meta: { label: 'Messages', sortKey: 'messages', align: 'right', defaultHidden: true },
            cell: ({ row }) => count(row.original.message_count),
        }),
        helper.display({
            id: 'memories',
            size: 72,
            meta: { label: 'Memories', sortKey: 'memories', align: 'right', defaultHidden: true },
            cell: ({ row }) => count(row.original.memory_count),
        }),
        helper.display({
            id: 'price',
            size: 90,
            meta: { label: 'Price', sortKey: 'price', defaultHidden: true },
            cell: ({ row }) => {
                const price = formatEventPrice(row.original);
                return price ? <span className="whitespace-nowrap text-ink-soft">{price}</span> : dash;
            },
        }),
        helper.display({
            id: 'discount',
            size: 80,
            meta: { label: 'Discount', defaultHidden: true },
            cell: ({ row }) => row.original.has_active_promo_codes ? <span className="text-success">Active</span> : dash,
        }),
        helper.display({
            id: 'program',
            size: 90,
            meta: { label: 'Program', defaultHidden: true },
            cell: ({ row }) => row.original.program_status
                ? <span className={row.original.program_status === 'published' ? 'text-success' : 'text-ink-soft'}>{row.original.program_status === 'published' ? 'Published' : 'Draft'}</span>
                : dash,
        }),
        helper.display({
            id: 'organizer',
            size: 120,
            meta: { label: 'Organizer', defaultHidden: true },
            cell: ({ row }) => {
                const organizer = row.original.organizer;
                return organizer ? <span className="block truncate text-ink-soft">{organizer.handle ? `@${organizer.handle}` : organizer.display_name}</span> : dash;
            },
        }),
        helper.display({
            id: 'actions',
            size: 48,
            enableHiding: false,
            enableResizing: false,
            meta: { label: 'Actions', pinned: true, align: 'right', customHeader: true },
            header: () => <span className="sr-only">Actions</span>,
            cell: ({ row: { original: event } }) => getAdminEventStatus(event) === 'new' && reviewLockReason(event) === null ? (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); ctx.onReview(event.event_id); }}
                    className="text-[10px] font-medium text-action hover:text-blue-800"
                    title="Mark reviewed"
                    aria-label={`Mark ${event.title} reviewed`}
                >
                    ✓
                </button>
            ) : null,
        }),
    ];
}

export const PINNED_START = ['select', 'title'];
export const PINNED_END = ['actions'];

/** Configurable columns in default order, with default visibility. */
export const CONFIGURABLE_COLUMNS = buildAdminEventColumns({
    selectedIds: new Set(),
    allPageSelected: false,
    onSelectAll: () => { },
    onToggleSelect: () => { },
    onReview: () => { },
    calendarLabel: (id) => id,
})
    .filter((column) => !column.meta?.pinned)
    .map((column) => ({ id: column.id as string, label: column.meta?.label ?? '', defaultHidden: Boolean(column.meta?.defaultHidden) }));
