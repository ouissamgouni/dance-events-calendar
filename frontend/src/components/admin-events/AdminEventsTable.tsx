import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { AdminEventSort } from '../../api';
import type { CalendarEvent } from '../../types';
import { getAdminEventRowClass, hasOpenChanges } from '../../utils/adminEventStatus';
import {
    PINNED_END,
    PINNED_START,
    buildAdminEventColumns,
    type AdminColumnContext,
} from './adminEventColumns';
import AdminDataTable, { type StickyColumns } from './AdminDataTable';
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

// Stay visible while the table scrolls horizontally; title sits right after the 32px checkbox.
const STICKY: StickyColumns = {
    select: { left: 0, cls: 'sticky z-[1]' },
    title: { left: 32, cls: 'sticky z-[1] shadow-[1px_0_0_var(--color-line)]' },
};

export default function AdminEventsTable({ events, context, prefs, setPrefs, sort, order, onSort, onRowClick }: Props) {
    const columns = useMemo(() => buildAdminEventColumns(context), [context]);

    return (
        <AdminDataTable
            data={events}
            columns={columns}
            getRowId={(row) => row.event_id}
            prefs={prefs}
            setPrefs={setPrefs}
            pinnedStart={PINNED_START}
            pinnedEnd={PINNED_END}
            sticky={STICKY}
            rowClassName={(event) => (context.selectedIds.has(event.event_id) ? 'bg-blue-100' : getAdminEventRowClass(event))}
            cellClassName={(event, id) => (id === 'select' && hasOpenChanges(event) ? 'border-l-4 border-orange-400' : '')}
            onRowClick={onRowClick}
            headerAriaSort={(meta) => (meta?.sortKey != null && meta.sortKey === sort ? (order === 'asc' ? 'ascending' : 'descending') : undefined)}
            renderHeaderLabel={(meta) => {
                const sortKey = meta?.sortKey;
                if (!sortKey) return null;
                const active = sortKey === sort;
                return (
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
                );
            }}
        />
    );
}
