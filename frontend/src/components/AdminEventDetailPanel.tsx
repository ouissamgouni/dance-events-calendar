import React, { useEffect, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { dismissDuplicateGroup, fetchAdminEvent, fetchAdminEventModeration, fetchAdminEvents, flagEventsAsDuplicates, scanEventDuplicates, updateAdminEventDraft, fetchEventDuplicateCandidates, keepDuplicateEvent, rejectSuggestion, setAdminEventStatus, updateEvent, fetchEventSeriesCandidates, splitSeriesMember, addEventsToSeries, fetchSeriesGroups, fetchOptionalAdminEventSchedule } from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import useBackToClose from '../hooks/useBackToClose';
import {
    ADMIN_EVENT_STATUS_CHIP_CLASSES,
    ADMIN_EVENT_STATUS_LABELS,
    getAdminEventPanelClass,
    getAdminEventStatus,
    getAdminEventStatusIcon,
    getRemovalReasonLabel,
} from '../utils/adminEventStatus';
import { useToast } from './Toast';
import AdminEventDetailContent from './AdminEventDetailContent';
import AdminEventModerationSection from './AdminEventModerationSection';
import AdminMockSourceEditor from './AdminMockSourceEditor';
import { splitDraftChanges, withDraft } from '../utils/eventRevisions';
import EventImageEditor from './EventImageEditor';
import AdminEventOrganizerField from './AdminEventOrganizerField';
import EventReviewsSection from './EventReviewsSection';
import EventMessagesSection from './EventMessagesSection';
import AdminEventNotificationsSection from './AdminEventNotificationsSection';
import EventMap from './EventMap';
import VisibilityChip, { WantsPublicChip } from './VisibilityChip';
import OverlappingEventsSection from './OverlappingEventsSection';
import MergeEventsDialog from './MergeEventsDialog';
import AdminEventOverviewModal from './AdminEventOverviewModal';
import type { AdminEventModeration, CalendarEvent, DuplicateGroup, SeriesGroup } from '../types';

// Taller on touch screens, compact on desktop.
const FOOTER_BTN = 'px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:py-1';

const CONFIRM_TEXT = {
    remove: 'Remove for everyone? It will not come back on the next sync.',
    restore: 'Restore this event? It goes back to Pending.',
    cancel: 'Mark as cancelled? It stays listed with a Cancelled badge.',
    uncancel: 'Undo the cancellation?',
} as const;

const CONFIRM_BUTTON = {
    remove: 'Yes, remove',
    restore: 'Yes, restore',
    cancel: 'Mark cancelled',
    uncancel: 'Undo cancellation',
} as const;

interface Props {
    eventId: string | null;
    onClose: () => void;
    onEventUpdated?: (eventId: string) => void;
}

export default function AdminEventDetailPanel({ eventId, onClose, onEventUpdated }: Props) {
    const toast = useToast();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [moderation, setModeration] = useState<AdminEventModeration | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    // Title inline editing
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleValue, setTitleValue] = useState('');
    const [savingTitle, setSavingTitle] = useState(false);
    const titleCancelledRef = useRef(false);

    // Hide / block confirm state
    const [confirmAction, setConfirmAction] = useState<'remove' | 'restore' | 'cancel' | 'uncancel' | null>(null);
    const [confirmNotify, setConfirmNotify] = useState(true);
    const [cancelNote, setCancelNote] = useState('');
    const [removeScope, setRemoveScope] = useState<'date' | 'all'>('date');
    const [ownerReason, setOwnerReason] = useState('');
    const [actionLoading, setActionLoading] = useState(false);

    // Potential duplicates
    const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
    const [duplicatesLoading, setDuplicatesLoading] = useState(false);
    const [duplicateActing, setDuplicateActing] = useState<number | null>(null);
    const [overlapOpenId, setOverlapOpenId] = useState<string | null>(null);
    const [mergeIds, setMergeIds] = useState<string[] | null>(null);
    const [previewId, setPreviewId] = useState<string | null>(null);
    const [dupSearch, setDupSearch] = useState('');
    const [dupResults, setDupResults] = useState<CalendarEvent[]>([]);
    const [dupSearching, setDupSearching] = useState(false);
    const [flagCandidateId, setFlagCandidateId] = useState<string | null>(null);
    const [flagging, setFlagging] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [scanFoundNone, setScanFoundNone] = useState(false);

    // Series membership
    const [seriesGroups, setSeriesGroups] = useState<SeriesGroup[]>([]);
    const [seriesLoading, setSeriesLoading] = useState(false);
    const [seriesActing, setSeriesActing] = useState(false);
    const [addSeriesOpen, setAddSeriesOpen] = useState(false);
    const [seriesSearch, setSeriesSearch] = useState('');
    const [seriesSearchResults, setSeriesSearchResults] = useState<SeriesGroup[]>([]);
    const [seriesSearchLoading, setSeriesSearchLoading] = useState(false);
    const [communityExpanded, setCommunityExpanded] = useState(false);
    const [messagesExpanded, setMessagesExpanded] = useState(false);
    const [notificationsExpanded, setNotificationsExpanded] = useState(false);
    const [hasSchedule, setHasSchedule] = useState<boolean | null>(null);

    const isOpen = eventId !== null;
    const submission = moderation?.submission;
    // Removing every date goes through the submission so its owner is told why.
    const removableSubmission = submission && !['blocked', 'withdrawn'].includes(submission.status) ? submission : null;
    const submissionDates = removableSubmission?.dates_total ?? 0;
    const submissionRemoval = confirmAction === 'remove' && Boolean(removableSubmission);
    const scopeDates = submissionRemoval ? submissionDates : moderation?.series_dates ?? 1;

    useEffect(() => {
        if (!eventId) {
            setEvent(null);
            setError(false);
            setEditingTitle(false);
            return;
        }
        setLoading(true);
        setError(false);
        setEvent(null);
        setModeration(null);
        fetchAdminEvent(eventId)
            .then((e) => { setEvent(e); setTitleValue(e.title); })
            .catch(() => setError(true))
            .finally(() => setLoading(false));
        fetchAdminEventModeration(eventId)
            .then(setModeration)
            .catch(() => setModeration(null));
    }, [eventId]);

    const reloadModeration = () => {
        if (!eventId) return;
        fetchAdminEventModeration(eventId)
            .then(setModeration)
            .catch(() => setModeration(null));
    };

    const handleModerationChanged = () => {
        if (!eventId) return;
        fetchAdminEvent(eventId)
            .then((e) => { setEvent(e); setTitleValue(e.title); })
            .catch(() => { });
        reloadModeration();
        onEventUpdated?.(eventId);
        notifyAdminDataChanged();
    };

    useEffect(() => {
        if (!eventId) {
            setDuplicateGroups([]);
            return;
        }
        setDupSearch('');
        setScanFoundNone(false);
        setDuplicatesLoading(true);
        fetchEventDuplicateCandidates(eventId)
            .then((res) => setDuplicateGroups(res.items))
            .catch(() => setDuplicateGroups([]))
            .finally(() => setDuplicatesLoading(false));
    }, [eventId]);

    const reloadDuplicates = () => {
        if (!eventId) return;
        fetchEventDuplicateCandidates(eventId)
            .then((res) => setDuplicateGroups(res.items))
            .catch(() => { });
        notifyAdminDataChanged();
    };

    useEffect(() => {
        const q = dupSearch.trim();
        if (!eventId || q.length < 2) {
            setDupResults([]);
            setDupSearching(false);
            return;
        }
        let cancelled = false;
        setDupSearching(true);
        const timer = setTimeout(() => {
            fetchAdminEvents({ search: q, limit: 10 })
                .then((res) => { if (!cancelled) setDupResults(res.items.filter((e) => e.event_id !== eventId)); })
                .catch(() => { if (!cancelled) setDupResults([]); })
                .finally(() => { if (!cancelled) setDupSearching(false); });
        }, 300);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [dupSearch, eventId]);

    const handleScanDuplicates = async () => {
        if (!eventId) return;
        setScanning(true);
        try {
            const res = await scanEventDuplicates(eventId);
            setDuplicateGroups(res.items);
            setScanFoundNone(res.items.length === 0);
            notifyAdminDataChanged();
        } catch (err) {
            toast.push({ title: err instanceof Error ? err.message : 'Could not scan for duplicates', variant: 'error' });
        } finally {
            setScanning(false);
        }
    };

    const handleFlagDuplicate = async (otherId: string) => {
        if (!eventId) return;
        setFlagging(true);
        try {
            await flagEventsAsDuplicates([eventId, otherId]);
            setFlagCandidateId(null);
            setDupSearch('');
            setScanFoundNone(false);
            reloadDuplicates();
            toast.push({ title: 'Flagged as duplicate', variant: 'success', duration: 2000 });
        } catch (err) {
            toast.push({ title: err instanceof Error ? err.message : 'Could not flag as duplicate', variant: 'error' });
        } finally {
            setFlagging(false);
        }
    };

    useEffect(() => {
        if (!eventId) {
            setSeriesGroups([]);
            setAddSeriesOpen(false);
            setSeriesSearch('');
            setSeriesSearchResults([]);
            return;
        }
        setSeriesLoading(true);
        fetchEventSeriesCandidates(eventId)
            .then((res) => setSeriesGroups(res.items))
            .catch(() => setSeriesGroups([]))
            .finally(() => setSeriesLoading(false));
    }, [eventId]);

    useEffect(() => {
        setHasSchedule(null);
        if (!eventId) return;
        let cancelled = false;
        fetchOptionalAdminEventSchedule(eventId)
            .then((s) => { if (!cancelled) setHasSchedule(s !== null); })
            .catch(() => { if (!cancelled) setHasSchedule(true); });
        return () => { cancelled = true; };
    }, [eventId]);

    useBackToClose(onClose, isOpen);

    // Keyboard close; a modal on top handles its own Escape.
    const childModalOpen = Boolean(mergeIds || previewId || flagCandidateId);
    useEffect(() => {
        if (!isOpen || childModalOpen) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [isOpen, onClose, childModalOpen]);

    const handleFieldSave = async (changes: Partial<CalendarEvent>) => {
        if (!event) return;
        // Published events: content edits wait in a draft until "Publish
        // changes"; operational edits (calendar, visibility…) stay immediate.
        const status = getAdminEventStatus(event);
        const published = (status === 'published' || status === 'cancelled') && event.visibility_state !== 'private';
        const { draft, immediate } = published
            ? splitDraftChanges(changes as Record<string, unknown>)
            : { draft: {}, immediate: changes as Record<string, unknown> };
        if (Object.keys(draft).length > 0) {
            await updateAdminEventDraft(event.event_id, draft);
            reloadModeration();
        }
        if (Object.keys(immediate).length === 0) return;
        const updated = await updateEvent(event.event_id, immediate as Partial<CalendarEvent>);
        setEvent(updated);
        setTitleValue(updated.title);
        onEventUpdated?.(updated.event_id);
        // Refresh badge counters — e.g. flipping review_status from
        // "pending" to "reviewed" needs to update the Pending Review badge.
        notifyAdminDataChanged();
    };

    const handleTagsUpdated = () => {
        if (!eventId) return;
        fetchAdminEvent(eventId)
            .then((e) => { setEvent(e); setTitleValue(e.title); })
            .catch(() => { });
        notifyAdminDataChanged();
    };

    const handleImageChange = (updated: CalendarEvent) => {
        setEvent(updated);
        onEventUpdated?.(updated.event_id);
    };

    const handleManualRefresh = () => {
        if (!eventId) return;
        setLoading(true);
        fetchAdminEvent(eventId)
            .then((e) => { setEvent(e); setTitleValue(e.title); })
            .catch(() => setError(true))
            .finally(() => setLoading(false));
        reloadModeration();
    };

    const handleHide = async () => {
        if (!event) return;
        setActionLoading(true);
        try {
            const updated = await updateEvent(event.event_id, { is_hidden: true });
            setEvent(updated);
            onEventUpdated?.(updated.event_id);
            notifyAdminDataChanged();
        } finally { setActionLoading(false); }
    };

    const handleUnhide = async () => {
        if (!event) return;
        setActionLoading(true);
        try {
            const updated = await updateEvent(event.event_id, { is_hidden: false });
            setEvent(updated);
            onEventUpdated?.(updated.event_id);
            notifyAdminDataChanged();
        } finally { setActionLoading(false); }
    };

    const openConfirm = (action: 'remove' | 'cancel' | 'uncancel') => {
        setConfirmNotify(true);
        setCancelNote('');
        setOwnerReason('');
        setRemoveScope(action === 'remove' && removableSubmission && submissionDates <= 1 ? 'all' : 'date');
        setConfirmAction(action);
    };

    const handlePublish = async () => {
        if (!event) return;
        setActionLoading(true);
        try {
            await updateEvent(event.event_id, { status: 'published' });
            handleModerationChanged();
        } catch (err) {
            toast.push({ title: err instanceof Error ? err.message : 'Could not publish', variant: 'error' });
        } finally { setActionLoading(false); }
    };

    const handleConfirmStatus = async () => {
        if (!event || !confirmAction) return;
        setActionLoading(true);
        try {
            if (confirmAction === 'remove' && removableSubmission && removeScope === 'all') {
                await rejectSuggestion(removableSubmission.suggestion_id, ownerReason.trim() || undefined, true);
            } else {
                await setAdminEventStatus(event.event_id, {
                    status: confirmAction === 'remove' ? 'removed' : confirmAction === 'cancel' ? 'cancelled' : 'published',
                    note: confirmAction === 'cancel' ? cancelNote.trim() || undefined : undefined,
                    notify: confirmAction === 'restore' ? false : confirmNotify,
                    scope: confirmAction !== 'restore' && removeScope === 'all' ? 'series' : 'date',
                });
            }
            handleModerationChanged();
        } catch (err) {
            toast.push({ title: err instanceof Error ? err.message : 'Could not change the status', variant: 'error' });
        } finally { setActionLoading(false); setConfirmAction(null); }
    };

    const handleKeepDuplicate = async (groupId: number, keepEventId: string) => {
        setDuplicateActing(groupId);
        try {
            const updated = await keepDuplicateEvent(groupId, keepEventId);
            setDuplicateGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
            notifyAdminDataChanged();
        } finally {
            setDuplicateActing(null);
        }
    };

    const handleDismissDuplicateGroup = async (groupId: number) => {
        setDuplicateActing(groupId);
        try {
            const updated = await dismissDuplicateGroup(groupId);
            setDuplicateGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
            notifyAdminDataChanged();
        } finally {
            setDuplicateActing(null);
        }
    };

    const handleRemoveFromSeries = async (seriesId: number) => {
        if (!eventId) return;
        setSeriesActing(true);
        try {
            await splitSeriesMember(seriesId, eventId);
            setSeriesGroups((prev) => prev.filter((g) => g.id !== seriesId));
            notifyAdminDataChanged();
        } finally {
            setSeriesActing(false);
        }
    };

    const runSeriesSearch = async () => {
        setSeriesSearchLoading(true);
        try {
            const res = await fetchSeriesGroups('all', { q: seriesSearch.trim() || undefined, limit: 20 });
            const memberSeriesIds = new Set(seriesGroups.map((g) => g.id));
            setSeriesSearchResults(res.items.filter((s) => !memberSeriesIds.has(s.id)));
        } finally {
            setSeriesSearchLoading(false);
        }
    };

    const handleAddToSeries = async (seriesId: number) => {
        if (!eventId) return;
        setSeriesActing(true);
        try {
            const updated = await addEventsToSeries(seriesId, [eventId]);
            setSeriesGroups([updated]);
            setAddSeriesOpen(false);
            setSeriesSearch('');
            setSeriesSearchResults([]);
            notifyAdminDataChanged();
        } finally {
            setSeriesActing(false);
        }
    };

    const handleTitleBlur = async () => {
        if (titleCancelledRef.current) { titleCancelledRef.current = false; return; }
        if (!event || titleValue === shownEvent?.title) { setEditingTitle(false); return; }
        setSavingTitle(true);
        try {
            await handleFieldSave({ title: titleValue });
        } finally {
            setSavingTitle(false);
            setEditingTitle(false);
        }
    };

    const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); handleTitleBlur(); }
        if (e.key === 'Escape') {
            titleCancelledRef.current = true;
            setTitleValue(event?.title ?? '');
            setEditingTitle(false);
        }
    };

    const handleShareReviewLink = async () => {
        if (!event) return;
        const reviewUrl = `${window.location.origin}/event/${event.event_id}/review`;
        try {
            if (typeof navigator.share === 'function') {
                await navigator.share({
                    title: `Review ${event.title}`,
                    text: `Share your experience at ${event.title}`,
                    url: reviewUrl,
                });
                return;
            }
            await navigator.clipboard.writeText(reviewUrl);
            toast.push({ title: 'Review link copied', variant: 'success', duration: 2000 });
        } catch (error) {
            if ((error as DOMException)?.name !== 'AbortError') {
                toast.push({ title: 'Could not share review link', variant: 'error' });
            }
        }
    };

    const shownEvent = event ? withDraft(event, moderation?.draft?.changes) : null;
    const visibility = moderation?.visibility ?? event?.visibility_state;

    return (
        <>
            {/* Backdrop — click closes only this panel, not the parent */}
            {isOpen && (
                <div className="fixed inset-0 z-[59]" onClick={onClose} />
            )}

            {/* Panel */}
            <div
                className={`fixed top-0 right-0 h-full w-[820px] max-w-[95vw] shadow-xl border-l border-line z-[60] flex flex-col transform transition-transform duration-200 ease-in-out ${getAdminEventPanelClass(event)} ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-3 border-b border-line bg-transparent shrink-0">
                    <div className="flex-1 min-w-0 mr-3">
                        {editingTitle ? (
                            <input
                                autoFocus
                                type="text"
                                value={titleValue}
                                onChange={(e) => setTitleValue(e.target.value)}
                                onBlur={handleTitleBlur}
                                onKeyDown={handleTitleKeyDown}
                                disabled={savingTitle}
                                className="w-full text-sm font-semibold text-ink border-b border-rose-300 bg-transparent focus:outline-none"
                            />
                        ) : (
                            <p
                                className={`text-sm font-semibold leading-snug truncate cursor-text hover:bg-canvas -mx-1 px-1 rounded transition ${event && getAdminEventStatus(event) === 'cancelled' ? 'text-ink-soft line-through' : 'text-ink'}`}
                                onClick={() => event && setEditingTitle(true)}
                                title="Click to edit title"
                            >
                                {loading ? 'Loading…' : (shownEvent?.title ?? '—')}
                            </p>
                        )}
                        <p className="text-[10px] text-muted mt-0.5 uppercase tracking-wide">Event detail · admin</p>
                        {event && (
                            <p className="text-[10px] text-muted mt-0.5 font-mono truncate" title={event.event_id}>
                                ID: {event.event_id}
                            </p>
                        )}
                        {event && (
                            <div className="flex flex-wrap items-center gap-1 mt-1">
                                {getAdminEventStatusIcon(event) && (
                                    <img
                                        src={getAdminEventStatusIcon(event) ?? undefined}
                                        alt=""
                                        aria-hidden="true"
                                        className="h-8 w-8 shrink-0 object-contain"
                                    />
                                )}
                                <span className={`px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${ADMIN_EVENT_STATUS_CHIP_CLASSES[getAdminEventStatus(event)]}`}>
                                    {ADMIN_EVENT_STATUS_LABELS[getAdminEventStatus(event)]}
                                </span>
                                {visibility && <VisibilityChip state={visibility} />}
                                {(moderation?.wants_public ?? event.wants_public) && <WantsPublicChip />}
                                {event.is_submission && (
                                    <span className="bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-action">Submitted</span>
                                )}
                                {(moderation?.open_revisions.length ?? 0) > 0 && (
                                    <span className="bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-800">Changes pending</span>
                                )}
                                {moderation?.draft && (
                                    <span className="bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-action">Unpublished draft</span>
                                )}
                                {getRemovalReasonLabel(event) && (
                                    <span
                                        className="bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-soft"
                                        title={event.block_reason_detail ?? undefined}
                                    >
                                        {getRemovalReasonLabel(event)}
                                    </span>
                                )}
                                {event.merged_into_event_id && (
                                    <button
                                        type="button"
                                        onClick={() => setOverlapOpenId(event.merged_into_event_id ?? null)}
                                        className="px-1.5 py-0.5 text-[10px] font-medium text-action hover:underline"
                                    >
                                        Merged into {event.merged_into_event_id}
                                    </button>
                                )}
                            </div>
                        )}
                        {event && getAdminEventStatus(event) === 'cancelled' && (
                            <div role="status" className="mt-2 border border-danger/20 bg-danger/10 px-2 py-1.5" data-testid="admin-event-cancelled-banner">
                                <p className="text-[11px] font-semibold text-danger">This event was cancelled</p>
                                {event.cancellation_note && <p className="mt-0.5 text-[11px] text-ink">{event.cancellation_note}</p>}
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <button
                            onClick={handleManualRefresh}
                            disabled={loading || !event}
                            className="text-muted hover:text-ink-soft disabled:opacity-40 p-1"
                            title="Refresh event"
                            aria-label="Refresh event"
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                            >
                                <polyline points="23 4 23 10 17 10" />
                                <polyline points="1 20 1 14 7 14" />
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                            </svg>
                        </button>
                        <button
                            onClick={onClose}
                            className="text-muted hover:text-ink-soft text-sm leading-none p-1"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {loading && (
                        <p className="text-xs text-muted text-center mt-8">Loading event…</p>
                    )}
                    {error && (
                        <p className="text-xs text-danger text-center mt-8">Failed to load event.</p>
                    )}
                    {event && (
                        <>
                            {moderation && (
                                <div className="mb-4">
                                    <AdminEventModerationSection
                                        event={event}
                                        moderation={moderation}
                                        onChanged={handleModerationChanged}
                                    />
                                </div>
                            )}
                            {!event.is_submission && (
                                <div className="mb-4">
                                    <AdminMockSourceEditor eventId={event.event_id} onSynced={handleModerationChanged} />
                                </div>
                            )}
                            <EventImageEditor event={event} onChange={handleImageChange} />
                            <AdminEventOrganizerField key={`organizer-${event.event_id}`} eventId={event.event_id} organizer={event.organizer} />
                            <AdminEventDetailContent
                                event={shownEvent ?? event}
                                onFieldSave={handleFieldSave}
                                onTagsUpdated={handleTagsUpdated}
                                compact
                            />
                            {!duplicatesLoading && (
                                <div className="mt-4 border border-amber-200 bg-amber-50 overflow-hidden" data-testid="potential-duplicates">
                                    <p className="px-3 pt-2 text-[10px] font-semibold text-amber-800 uppercase tracking-wide">
                                        Potential duplicates
                                    </p>
                                    <div className="flex gap-2 px-3 py-2">
                                        <input
                                            type="search"
                                            value={dupSearch}
                                            onChange={(e) => setDupSearch(e.target.value)}
                                            placeholder="Search events…"
                                            aria-label="Search events"
                                            className="min-w-0 flex-1 border border-line bg-surface px-2 py-1 text-xs"
                                        />
                                        <button
                                            type="button"
                                            onClick={handleScanDuplicates}
                                            disabled={scanning}
                                            className="text-[11px] bg-amber-600 text-white px-2.5 py-1 hover:bg-amber-700 disabled:opacity-50"
                                        >
                                            {scanning ? 'Scanning…' : 'Scan'}
                                        </button>
                                    </div>
                                    {dupSearch.trim().length >= 2 && (
                                        <div className="mx-3 mb-2 max-h-48 overflow-y-auto border border-line bg-surface" data-testid="duplicate-search-results">
                                            {dupSearching ? (
                                                <p className="px-2 py-1.5 text-[11px] text-muted">Searching…</p>
                                            ) : dupResults.length === 0 ? (
                                                <p className="px-2 py-1.5 text-[11px] text-muted">No events found.</p>
                                            ) : dupResults.map((ev) => (
                                                <button
                                                    key={ev.event_id}
                                                    type="button"
                                                    onClick={() => setFlagCandidateId(ev.event_id)}
                                                    className="flex w-full items-center justify-between gap-2 border-b border-card-line px-2 py-1.5 text-left last:border-b-0 hover:bg-amber-50"
                                                >
                                                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{ev.title}</span>
                                                    <span className="shrink-0 text-[10px] text-muted">{new Date(ev.start).toLocaleString()}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {scanFoundNone && duplicateGroups.length === 0 && (
                                        <p className="px-3 pb-2 text-[11px] text-amber-800">No duplicates found.</p>
                                    )}
                                    {duplicateGroups.length > 0 && (
                                        <ul className="divide-y divide-amber-100 border-t border-amber-100">
                                            {duplicateGroups.map((g) => (
                                                <li key={g.id} className="px-3 py-2">
                                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                                        <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-amber-100 text-amber-700">
                                                            {g.status}
                                                        </span>
                                                        <span className="text-[10px] uppercase text-amber-600">{g.source}</span>
                                                    </div>
                                                    <ul className="space-y-1">
                                                        {g.events
                                                            .filter((ev) => ev.event_id !== event.event_id)
                                                            .map((ev) => (
                                                                <li key={ev.event_id} className="text-xs text-ink">
                                                                    {ev.title} — {new Date(ev.start).toLocaleString()}
                                                                </li>
                                                            ))}
                                                    </ul>
                                                    {g.status === 'pending' && (
                                                        <div className="mt-1.5 flex items-center gap-2">
                                                            <button
                                                                disabled={duplicateActing === g.id}
                                                                onClick={() => handleKeepDuplicate(g.id, event.event_id)}
                                                                className="text-[11px] bg-action text-white px-2 py-1 hover:bg-action disabled:opacity-50"
                                                            >
                                                                Keep this event
                                                            </button>
                                                            <button
                                                                disabled={duplicateActing === g.id}
                                                                onClick={() => setMergeIds(g.events.map((ev) => ev.event_id))}
                                                                className="border border-line bg-surface px-2 py-1 text-[11px] font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                                                            >
                                                                Merge…
                                                            </button>
                                                            <button
                                                                disabled={duplicateActing === g.id}
                                                                onClick={() => handleDismissDuplicateGroup(g.id)}
                                                                className="text-[11px] text-amber-700 hover:text-amber-900 px-2 py-1 disabled:opacity-50"
                                                            >
                                                                Not duplicates
                                                            </button>
                                                        </div>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}
                            <OverlappingEventsSection
                                key={`overlap-${event.event_id}`}
                                eventId={event.event_id}
                                onOpenEvent={setPreviewId}
                            />
                            {!seriesLoading && (
                                <div className="mt-4 border border-teal-200 bg-teal-50 overflow-hidden">
                                    <p className="px-3 py-2 text-[10px] font-semibold text-teal-800 uppercase tracking-wide">
                                        Series
                                    </p>
                                    {seriesGroups.length > 0 ? (
                                        <ul className="divide-y divide-teal-100">
                                            {seriesGroups.map((g) => (
                                                <li key={g.id} className="px-3 py-2">
                                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                                        <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-teal-100 text-teal-700">
                                                            {g.status}
                                                        </span>
                                                        <span className="font-medium text-xs text-ink">{g.canonical_title}</span>
                                                        <span className="text-[10px] text-ink-soft">{g.events.length} event(s)</span>
                                                    </div>
                                                    <button
                                                        disabled={seriesActing}
                                                        onClick={() => handleRemoveFromSeries(g.id)}
                                                        className="text-[11px] text-teal-700 hover:text-teal-900 px-2 py-1 disabled:opacity-50"
                                                    >
                                                        Remove from series
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <div className="px-3 py-2">
                                            {!addSeriesOpen ? (
                                                <button
                                                    onClick={() => { setAddSeriesOpen(true); setSeriesSearch(''); setSeriesSearchResults([]); }}
                                                    className="text-[11px] bg-teal-600 text-white px-2 py-1 hover:bg-teal-700"
                                                >
                                                    Add to series
                                                </button>
                                            ) : (
                                                <div className="space-y-2">
                                                    <div className="flex gap-2">
                                                        <input
                                                            type="text"
                                                            value={seriesSearch}
                                                            onChange={(e) => setSeriesSearch(e.target.value)}
                                                            onKeyDown={(e) => { if (e.key === 'Enter') runSeriesSearch(); }}
                                                            placeholder="Search series by title…"
                                                            className="flex-1 text-xs border border-line px-2 py-1"
                                                        />
                                                        <button
                                                            onClick={runSeriesSearch}
                                                            disabled={seriesSearchLoading}
                                                            className="text-[11px] bg-teal-600 text-white px-2.5 py-1 hover:bg-teal-700 disabled:opacity-50"
                                                        >
                                                            {seriesSearchLoading ? 'Searching…' : 'Search'}
                                                        </button>
                                                    </div>
                                                    {seriesSearchResults.length > 0 && (
                                                        <div className="max-h-40 overflow-y-auto border border-line bg-surface">
                                                            {seriesSearchResults.map((s) => (
                                                                <button
                                                                    key={s.id}
                                                                    onClick={() => handleAddToSeries(s.id)}
                                                                    disabled={seriesActing}
                                                                    className="flex w-full items-center justify-between gap-2 border-b border-card-line px-2 py-1.5 text-left last:border-b-0 hover:bg-teal-50 disabled:opacity-50"
                                                                >
                                                                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{s.canonical_title}</span>
                                                                    <span className="text-[10px] text-muted">{s.events.length} · {s.status}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                    <button
                                                        onClick={() => { setAddSeriesOpen(false); setSeriesSearch(''); setSeriesSearchResults([]); }}
                                                        className="text-[10px] text-ink-soft hover:text-ink"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                            <div className="mt-4 border border-line overflow-hidden">
                                {event.latitude != null && event.longitude != null ? (
                                    <div className="h-[300px]">
                                        <EventMap events={[event]} />
                                    </div>
                                ) : (
                                    <div className="px-3 py-4 bg-canvas">
                                        <p className="text-xs font-medium text-ink">Map unavailable</p>
                                        <p className="mt-1 text-xs text-ink-soft">
                                            {event.location
                                                ? 'This event has a location text but is not geocoded yet.'
                                                : 'This event has no location set yet.'}
                                        </p>
                                    </div>
                                )}
                            </div>
                            <div className="mt-4 border border-line overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => setCommunityExpanded((v) => !v)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-canvas transition"
                                >
                                    <span className="text-muted text-[10px]">{communityExpanded ? '▾' : '▸'}</span>
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">Community Experience</span>
                                </button>
                                {communityExpanded && (
                                    <div className="border-t border-line px-3 pb-3">
                                        <EventReviewsSection
                                            eventId={event.event_id}
                                            isPast={new Date(event.end).getTime() < Date.now()}
                                        />
                                    </div>
                                )}
                            </div>
                            <div className="mt-4 border border-line overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => setMessagesExpanded((v) => !v)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-canvas transition"
                                >
                                    <span className="text-muted text-[10px]">{messagesExpanded ? '▾' : '▸'}</span>
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">Messages</span>
                                </button>
                                {messagesExpanded && (
                                    <div className="border-t border-line px-3 pb-3">
                                        <EventMessagesSection
                                            eventId={event.event_id}
                                            isPast={new Date(event.end).getTime() < Date.now()}
                                        />
                                    </div>
                                )}
                            </div>
                            <div className="mt-4 border border-line overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => setNotificationsExpanded((v) => !v)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-canvas transition"
                                >
                                    <span className="text-muted text-[10px]">{notificationsExpanded ? '▾' : '▸'}</span>
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">Notifications</span>
                                </button>
                                {notificationsExpanded && (
                                    <div className="border-t border-line px-3 pb-3">
                                        <AdminEventNotificationsSection event={event} />
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Footer: one row of event-level actions; confirmations replace it in place. */}
                {event && (
                    <div className="shrink-0 border-t border-line bg-canvas px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-5">
                        {confirmAction ? (
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                <span className="mr-auto text-xs text-ink">
                                    {confirmAction === 'remove' && removableSubmission && removeScope === 'all'
                                        ? `Remove ${submissionDates > 1 ? `all ${submissionDates} dates` : 'it'} for everyone, its owner included?`
                                        : CONFIRM_TEXT[confirmAction]}
                                </span>
                                {scopeDates > 1 && confirmAction !== 'restore' && (
                                    <div role="radiogroup" aria-label="Apply to" className="flex items-center gap-3 text-xs text-ink">
                                        <label className="flex items-center gap-1.5">
                                            <input type="radio" name="remove-scope" checked={removeScope === 'date'} onChange={() => setRemoveScope('date')} className="h-3.5 w-3.5" />
                                            This date
                                        </label>
                                        <label className="flex items-center gap-1.5">
                                            <input type="radio" name="remove-scope" checked={removeScope === 'all'} onChange={() => setRemoveScope('all')} className="h-3.5 w-3.5" />
                                            {submissionRemoval ? `All ${scopeDates} dates` : `All ${scopeDates} upcoming dates`}
                                        </label>
                                    </div>
                                )}
                                {confirmAction === 'remove' && removableSubmission && removeScope === 'all' && (
                                    <input
                                        type="text"
                                        value={ownerReason}
                                        onChange={(e) => setOwnerReason(e.target.value)}
                                        placeholder="Reason shown to the owner"
                                        aria-label="Reason shown to the owner"
                                        maxLength={500}
                                        className="min-w-[200px] flex-1 border border-line px-2 py-1 text-xs"
                                    />
                                )}
                                {confirmAction === 'cancel' && (
                                    <input
                                        type="text"
                                        value={cancelNote}
                                        onChange={(e) => setCancelNote(e.target.value)}
                                        placeholder="Note for attendees (optional)"
                                        aria-label="Cancellation note"
                                        maxLength={500}
                                        className="min-w-[200px] flex-1 border border-line px-2 py-1 text-xs"
                                    />
                                )}
                                {confirmAction !== 'restore' && !(confirmAction === 'remove' && removableSubmission && removeScope === 'all') && (
                                    <label className="flex items-center gap-1.5 text-xs text-ink">
                                        <input
                                            type="checkbox"
                                            checked={confirmNotify}
                                            onChange={(e) => setConfirmNotify(e.target.checked)}
                                            className="h-3.5 w-3.5"
                                        />
                                        Notify attendees
                                    </label>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setConfirmAction(null)}
                                    className={`${FOOTER_BTN} text-ink-soft hover:text-ink`}
                                >
                                    Back
                                </button>
                                <button
                                    type="button"
                                    onClick={handleConfirmStatus}
                                    disabled={actionLoading}
                                    className={`${FOOTER_BTN} ${confirmAction === 'remove'
                                        ? 'bg-danger text-white hover:bg-danger/90'
                                        : 'bg-action text-white hover:opacity-90'}`}
                                >
                                    {CONFIRM_BUTTON[confirmAction]}
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-wrap items-center gap-2">
                                <Link
                                    to={`/event/${event.event_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="py-1.5 text-xs font-medium text-action hover:underline sm:py-1"
                                >
                                    See full details ↗
                                </Link>
                                {hasSchedule !== null && (
                                    <Link
                                        to={`/admin/events/${encodeURIComponent(event.event_id)}/schedule`}
                                        onClick={onClose}
                                        className={`${FOOTER_BTN} border border-line bg-surface text-ink hover:bg-canvas`}
                                    >
                                        {hasSchedule ? 'Manage schedule' : 'Add schedule'}
                                    </Link>
                                )}
                                {new Date(event.end).getTime() < Date.now() && (
                                    <button
                                        type="button"
                                        onClick={handleShareReviewLink}
                                        className={`${FOOTER_BTN} inline-flex items-center gap-1.5 border border-line bg-surface text-ink hover:bg-canvas`}
                                    >
                                        <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
                                        Share review link
                                    </button>
                                )}
                                <div className="ml-auto flex items-center gap-2">
                                    {getAdminEventStatus(event) === 'removed' ? (
                                        <button
                                            type="button"
                                            onClick={() => setConfirmAction('restore')}
                                            className={`${FOOTER_BTN} border border-line bg-surface text-ink hover:bg-canvas`}
                                        >
                                            Restore
                                        </button>
                                    ) : (
                                        <>
                                            {getAdminEventStatus(event) === 'new' && (
                                                <button
                                                    type="button"
                                                    onClick={handlePublish}
                                                    disabled={actionLoading}
                                                    className={`${FOOTER_BTN} bg-action text-white hover:opacity-90`}
                                                >
                                                    Publish
                                                </button>
                                            )}
                                            {getAdminEventStatus(event) === 'cancelled' ? (
                                                <button
                                                    type="button"
                                                    onClick={() => openConfirm('uncancel')}
                                                    className={`${FOOTER_BTN} border border-line bg-surface text-ink hover:bg-canvas`}
                                                >
                                                    Undo cancellation…
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={getAdminEventStatus(event) === 'unpublished' ? handleUnhide : handleHide}
                                                    disabled={actionLoading}
                                                    className={`${FOOTER_BTN} border border-line bg-surface text-ink hover:bg-canvas`}
                                                >
                                                    {getAdminEventStatus(event) === 'unpublished' ? 'Republish' : 'Unpublish'}
                                                </button>
                                            )}
                                            {getAdminEventStatus(event) === 'published' && (
                                                <button
                                                    type="button"
                                                    onClick={() => openConfirm('cancel')}
                                                    className={`${FOOTER_BTN} border border-line bg-surface text-ink hover:bg-canvas`}
                                                >
                                                    Cancel event…
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => openConfirm('remove')}
                                                className={`${FOOTER_BTN} border border-danger/40 bg-surface text-danger hover:bg-danger/5`}
                                            >
                                                Remove…
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {overlapOpenId && (
                <AdminEventDetailPanel
                    eventId={overlapOpenId}
                    onClose={() => setOverlapOpenId(null)}
                    onEventUpdated={onEventUpdated}
                />
            )}
            {previewId && (
                <AdminEventOverviewModal
                    eventId={previewId}
                    onClose={() => setPreviewId(null)}
                    actions={(ev) => (
                        <>
                            <button
                                type="button"
                                onClick={() => setPreviewId(null)}
                                className={`${FOOTER_BTN} text-ink-soft hover:text-ink`}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                onClick={() => { setPreviewId(null); setOverlapOpenId(ev.event_id); }}
                                className={`${FOOTER_BTN} border border-line bg-surface text-ink hover:bg-canvas`}
                            >
                                Open in admin
                            </button>
                        </>
                    )}
                />
            )}
            {flagCandidateId && (
                <AdminEventOverviewModal
                    eventId={flagCandidateId}
                    onClose={() => setFlagCandidateId(null)}
                    actions={(ev) => (
                        <>
                            <button
                                type="button"
                                onClick={() => setFlagCandidateId(null)}
                                className={`${FOOTER_BTN} text-ink-soft hover:text-ink`}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => handleFlagDuplicate(ev.event_id)}
                                disabled={flagging}
                                className={`${FOOTER_BTN} bg-action text-white hover:opacity-90`}
                            >
                                Flag as duplicate
                            </button>
                        </>
                    )}
                />
            )}
            {mergeIds && event && (
                <MergeEventsDialog
                    eventIds={mergeIds}
                    initialTargetId={event.event_id}
                    onClose={() => setMergeIds(null)}
                    onMerged={(result) => {
                        setMergeIds(null);
                        toast.push({ title: `Merged ${result.merged_event_ids.length + 1} events`, variant: 'success' });
                        handleModerationChanged();
                        reloadDuplicates();
                        if (result.target_event_id !== event.event_id) setOverlapOpenId(result.target_event_id);
                    }}
                />
            )}
        </>
    );
}
