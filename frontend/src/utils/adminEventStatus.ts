import type { AdminEventBlockReason, AdminEventStatus, CalendarEvent } from '../types';

export function getAdminEventStatus(event: CalendarEvent): AdminEventStatus {
    if (event.status) return event.status;
    if (event.is_blocked) return 'blocked';
    return event.review_status === 'pending' ? 'pending' : 'reviewed';
}

export function getAdminEventRowClass(event: CalendarEvent): string {
    const status = getAdminEventStatus(event);
    if (status === 'blocked') return 'bg-admin-blocked hover:brightness-95';
    if (event.is_hidden) return 'bg-admin-hidden hover:brightness-95';
    if (status === 'pending') return 'bg-amber-50 hover:bg-amber-100/70';
    return 'bg-surface hover:bg-canvas/50';
}

export function getAdminEventPanelClass(event: CalendarEvent | null): string {
    if (!event) return 'bg-surface';
    const status = getAdminEventStatus(event);
    if (status === 'blocked') return 'bg-admin-blocked';
    if (event.is_hidden) return 'bg-admin-hidden';
    if (status === 'pending') return 'bg-amber-50';
    return 'bg-surface';
}

export function getAdminEventStatusIcon(event: CalendarEvent): string | null {
    if (getAdminEventStatus(event) === 'blocked') return '/blocked.png';
    if (event.is_hidden) return '/hide.png';
    return null;
}

export const ADMIN_EVENT_STATUS_CHIP_CLASSES: Record<AdminEventStatus, string> = {
    pending: 'bg-amber-100 text-amber-800',
    reviewed: 'bg-emerald-50 text-success',
    blocked: 'bg-slate-300 text-ink',
};

export const ADMIN_EVENT_HIDDEN_CHIP_CLASS = 'bg-slate-200 text-ink-soft';

const BLOCK_REASON_LABELS: Record<AdminEventBlockReason, string> = {
    deleted: 'Deleted',
    duplicate: 'Duplicate',
    rejected: 'Rejected',
};

export function getBlockReasonLabel(reason: AdminEventBlockReason | null | undefined): string | null {
    return reason ? BLOCK_REASON_LABELS[reason] : null;
}
