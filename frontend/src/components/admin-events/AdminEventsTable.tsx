import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { flexRender, useTable } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { AdminEventSort } from '../../api';
import type { CalendarEvent } from '../../types';
import { getAdminEventRowClass, hasOpenChanges } from '../../utils/adminEventStatus';
import {
    PINNED_END,
    PINNED_START,
    adminTableFeatures,
    buildAdminEventColumns,
    type AdminColumnContext,
} from './adminEventColumns';
import type { AdminEventsTablePrefs } from './useAdminEventsTablePrefs';
import { nextSort, type SortOrder } from './adminEventFilters';

interface Props {
    events: CalendarEvent[];
    context: AdminColumnContext;
    prefs: AdminEventsTablePrefs;
    setPrefs: Dispatch<SetStateAction<AdminEventsTablePrefs>>;
    sort: AdminEventSort;
    order: SortOrder;
    onSort: (sort: AdminEventSort, order: SortOrder) => void;
    onRowClick: (eventId: string) => void;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

export default function AdminEventsTable({ events, context, prefs, setPrefs, sort, order, onSort, onRowClick }: Props) {
    const columns = useMemo(() => buildAdminEventColumns(context), [context]);
    const table = useTable({
        features: adminTableFeatures,
        columns,
        data: events,
        getRowId: (row) => row.event_id,
        enableColumnResizing: true,
        columnResizeMode: 'onChange',
        state: {
            columnOrder: [...PINNED_START, ...prefs.order, ...PINNED_END],
            columnVisibility: Object.fromEntries(prefs.hidden.map((id) => [id, false])),
            columnSizing: prefs.sizing,
        },
        onColumnSizingChange: (updater) => setPrefs((prev) => ({
            ...prev,
            sizing: typeof updater === 'function' ? updater(prev.sizing) : updater,
        })),
    });

    return (
        <table className="table-fixed text-[11px]" style={{ width: '100%', minWidth: table.getTotalSize() }}>
            <thead className="sticky top-0 z-10 border-b border-line bg-canvas">
                {table.getHeaderGroups().map((group) => (
                    <tr key={group.id}>
                        {group.headers.map((header) => {
                            const meta = header.column.columnDef.meta;
                            const sortKey = meta?.sortKey;
                            const active = sortKey != null && sortKey === sort;
                            const align = ALIGN[meta?.align ?? 'left'];
                            return (
                                <th
                                    key={header.id}
                                    scope="col"
                                    style={{ width: header.getSize() }}
                                    aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
                                    title={meta?.title}
                                    className={`relative whitespace-nowrap px-2 py-2 font-semibold uppercase tracking-wide text-ink-soft ${align}`}
                                >
                                    {sortKey ? (
                                        <button
                                            type="button"
                                            onClick={() => onSort(...nextSort(sort, order, sortKey))}
                                            className={`inline-flex max-w-full items-center gap-1 uppercase tracking-wide hover:text-ink ${active ? 'text-action' : ''}`}
                                        >
                                            <span className="truncate">{meta?.label}</span>
                                            {active ? (
                                                order === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0" aria-hidden="true" /> : <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                                            ) : (
                                                <ArrowUpDown className="h-3 w-3 shrink-0 opacity-40" aria-hidden="true" />
                                            )}
                                        </button>
                                    ) : meta?.customHeader ? (
                                        flexRender(header.column.columnDef.header, header.getContext())
                                    ) : (
                                        <span className="block truncate">{meta?.label}</span>
                                    )}
                                    {header.column.getCanResize() && (
                                        <div
                                            role="separator"
                                            aria-orientation="vertical"
                                            aria-label={`Resize ${meta?.label}`}
                                            onMouseDown={header.getResizeHandler()}
                                            onTouchStart={header.getResizeHandler()}
                                            onDoubleClick={() => header.column.resetSize()}
                                            className={`absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-action/40 ${header.column.getIsResizing() ? 'bg-action' : ''}`}
                                        />
                                    )}
                                </th>
                            );
                        })}
                        {/* Absorbs leftover width so shrinking a column isn't undone by table stretch. */}
                        <th aria-hidden="true" className="p-0" />
                    </tr>
                ))}
            </thead>
            <tbody className="divide-y divide-gray-100">
                {table.getRowModel().rows.map((row) => (
                    <tr
                        key={row.id}
                        className={`cursor-pointer transition ${context.selectedIds.has(row.id) ? 'bg-blue-50/40' : getAdminEventRowClass(row.original)}`}
                        onClick={() => onRowClick(row.id)}
                    >
                        {row.getVisibleCells().map((cell) => {
                            const id = cell.column.id;
                            return (
                                <td
                                    key={cell.id}
                                    style={{ width: cell.column.getSize() }}
                                    onClick={id === 'select' ? (e) => e.stopPropagation() : undefined}
                                    className={`overflow-hidden px-2 py-1.5 ${ALIGN[cell.column.columnDef.meta?.align ?? 'left']} ${id === 'select' && hasOpenChanges(row.original) ? 'border-l-4 border-orange-400' : ''}`}
                                >
                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </td>
                            );
                        })}
                        <td aria-hidden="true" className="p-0" />
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
