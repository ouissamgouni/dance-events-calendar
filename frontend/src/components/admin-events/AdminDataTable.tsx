import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { flexRender, useTable, type RowData, type TableOptions } from '@tanstack/react-table';
import { adminTableFeatures, type AdminColumnMeta } from './adminEventColumns';
import type { AdminEventsTablePrefs } from './useAdminEventsTablePrefs';

export type StickyColumns = Record<string, { left: number; cls: string }>;

interface Props<T extends RowData> {
    data: T[];
    columns: TableOptions<typeof adminTableFeatures, T>['columns'];
    getRowId: (row: T) => string;
    prefs: AdminEventsTablePrefs;
    setPrefs: Dispatch<SetStateAction<AdminEventsTablePrefs>>;
    pinnedStart?: string[];
    pinnedEnd?: string[];
    sticky?: StickyColumns;
    rowClassName: (row: T) => string;
    cellClassName?: (row: T, columnId: string) => string;
    onRowClick: (id: string) => void;
    /** Replaces the plain label, e.g. with a sort button; return null to keep the label. */
    renderHeaderLabel?: (meta: AdminColumnMeta | undefined) => ReactNode;
    headerAriaSort?: (meta: AdminColumnMeta | undefined) => 'ascending' | 'descending' | undefined;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/** Resizable, reorderable admin grid whose column layout lives in `prefs`. */
export default function AdminDataTable<T extends RowData>({
    data, columns, getRowId, prefs, setPrefs, pinnedStart = [], pinnedEnd = [], sticky = {},
    rowClassName, cellClassName, onRowClick, renderHeaderLabel, headerAriaSort,
}: Props<T>) {
    const table = useTable({
        features: adminTableFeatures,
        columns,
        data,
        getRowId,
        enableColumnResizing: true,
        columnResizeMode: 'onChange',
        state: {
            columnOrder: [...pinnedStart, ...prefs.order, ...pinnedEnd],
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
                            const stick = sticky[header.column.id];
                            const custom = renderHeaderLabel?.(meta);
                            return (
                                <th
                                    key={header.id}
                                    scope="col"
                                    style={{ width: header.getSize(), left: stick?.left }}
                                    aria-sort={headerAriaSort?.(meta)}
                                    title={meta?.title}
                                    className={`whitespace-nowrap px-2 py-2 font-semibold uppercase tracking-wide text-ink-soft ${ALIGN[meta?.align ?? 'left']} ${stick ? `${stick.cls} bg-canvas` : 'relative'}`}
                                >
                                    {custom ? custom : meta?.customHeader ? (
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
                        className={`cursor-pointer transition ${rowClassName(row.original)}`}
                        onClick={() => onRowClick(row.id)}
                    >
                        {row.getVisibleCells().map((cell) => {
                            const id = cell.column.id;
                            const stick = sticky[id];
                            return (
                                <td
                                    key={cell.id}
                                    style={{ width: cell.column.getSize(), left: stick?.left }}
                                    onClick={id === 'select' ? (e) => e.stopPropagation() : undefined}
                                    className={`overflow-hidden px-2 py-1.5 ${ALIGN[cell.column.columnDef.meta?.align ?? 'left']} ${stick ? `${stick.cls} bg-inherit` : ''} ${cellClassName?.(row.original, id) ?? ''}`}
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
