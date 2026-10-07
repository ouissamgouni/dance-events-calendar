import type { AdminEventRemovalReason, AdminEventStatus, CalendarEvent } from '../types';

export function getAdminEventStatus(event: CalendarEvent): AdminEventStatus {
    if (event.status) return event.status;
    if (event.is_blocked) return 'removed';
    if (event.is_hidden) return 'unpublished';
    return event.review_status === 'pending' ? 'new' : 'published';
}

export const ADMIN_EVENT_STATUS_LABELS: Record<AdminEventStatus, string> = {
    new: 'New',
    published: 'Published',
    unpublished: 'Unpublished',
    cancelled: 'Cancelled',
    removed: 'Removed',
};

export function getAdminEventRowClass(event: CalendarEvent): string {
    const status = getAdminEventStatus(event);
    if (status === 'removed') return 'bg-admin-blocked hover:brightness-95';
    if (status === 'unpublished') return 'bg-admin-hidden hover:brightness-95';
    if (status === 'cancelled') return 'bg-red-50/60 hover:bg-red-50';
    if (status === 'new') return 'bg-blue-50 hover:bg-blue-100/70';
    return 'bg-surface hover:bg-canvas/50';
}

export function getAdminEventPanelClass(event: CalendarEvent | null): string {
    if (!event) return 'bg-surface';
    const status = getAdminEventStatus(event);
    if (status === 'removed') return 'bg-admin-blocked';
    if (status === 'unpublished') return 'bg-admin-hidden';
    if (status === 'cancelled') return 'bg-red-50';
    if (status === 'new') return 'bg-blue-50';
    return 'bg-surface';
}

export function getAdminEventStatusIcon(event: CalendarEvent): string | null {
    const status = getAdminEventStatus(event);
    if (status === 'removed') return '/blocked.png';
    if (status === 'unpublished') return '/hide.png';
    return null;
}

/** Why the status can't be set to new/published directly, or null when it can. */
export function reviewLockReason(event: CalendarEvent): string | null {
    const status = getAdminEventStatus(event);
    if (status === 'removed') return 'Removed';
    if (status === 'cancelled') return 'Cancelled';
    if (!event.is_submission) return null;
    if (event.wants_public) return 'Owner asked to go public — decide above';
    if (event.visibility_state !== 'private') return 'Made public from the submission';
    return null;
}

export const ADMIN_EVENT_STATUS_CHIP_CLASSES: Record<AdminEventStatus, string> = {
    new: 'bg-blue-100 text-action',
    published: 'bg-emerald-50 text-success',
    unpublished: 'bg-slate-200 text-ink-soft',
    cancelled: 'bg-red-50 text-danger',
    removed: 'bg-slate-300 text-ink',
};

const REMOVAL_REASON_LABELS: Record<AdminEventRemovalReason, string> = {
    admin: 'Removed by admin',
    duplicate: 'Duplicate',
    owner: 'Deleted by owner',
    google_calendar: 'Deleted in Google Calendar',
    series_edit: 'Dropped from series',
    rejected: 'Rejected',
    merged: 'Merged',
};

export function getRemovalReasonLabel(event: CalendarEvent): string | null {
    if (getAdminEventStatus(event) !== 'removed' || !event.status_reason) return null;
    return REMOVAL_REASON_LABELS[event.status_reason];
}

export function hasOpenChanges(event: CalendarEvent): boolean {
    return Boolean(event.has_pending_changes) && getAdminEventStatus(event) !== 'removed';
}
