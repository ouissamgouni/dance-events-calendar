import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, CalendarX, MessageSquare, MoreHorizontal, PencilLine, Ticket, Wrench } from 'lucide-react';
import type { CalendarEvent } from '../types';
import GoingButton from './GoingButton';
import SaveEventButton from './SaveEventButton';
import ShareButton from './ShareButton';
import RateEventButton from './RateEventButton';
import TicketSheet from './TicketSheet';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useTicketAction } from '../hooks/useTicketAction';
import useOrganizerClaimAction from '../hooks/useOrganizerClaimAction';
import { useAuth } from '../context/AuthContext';
import CancelEventSheet from './CancelEventSheet';

interface Props {
    event: CalendarEvent;
    isPast: boolean;
    shareUrl: string;
    reviewOpenToken?: number;
    onRatingChanged?: () => void;
    eventHasReviews?: boolean;
    /** Open the Discussion tab / composer ("Start discussion"). */
    onPostMessage: () => void;
    /** Optional "Suggest an edit" affordance. */
    onSuggestEdit?: () => void;
    /** Organizers edit directly, so the action reads "Edit event" for them. */
    suggestEditLabel?: string;
    /** Optional admin-only event editor affordance. */
    onAdminEdit?: () => void;
}

/**
 * Persistent action dock pinned to the bottom on mobile and presented as a
 * sticky side panel on desktop. On mobile secondary actions live in the •••
 * menu; on desktop every action is listed as its own button.
 */
export default function EventActionDock({
    event,
    isPast,
    shareUrl,
    reviewOpenToken,
    onRatingChanged,
    eventHasReviews,
    onPostMessage,
    onSuggestEdit,
    suggestEditLabel = 'Suggest an edit',
    onAdminEdit,
}: Props) {
    const { showRatings } = useFeatureFlags();
    const ticket = useTicketAction(event);
    const organizerClaim = useOrganizerClaimAction(event);
    const { user } = useAuth();
    const isOrganizer = Boolean(user && event.organizer?.user_id === user.user_id);
    const cancelLabel = event.is_cancelled ? 'Restore event' : 'Cancel event';
    const [cancelOpen, setCancelOpen] = useState(false);
    const [ticketOpen, setTicketOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [menuOpen]);

    const reviewInline = showRatings && isPast;
    const cancelled = Boolean(event.is_cancelled);
    const desktopButton = 'hidden h-10 w-full items-center gap-2 rounded-field border border-line bg-surface px-3 text-sm text-ink transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface lg:flex';
    const menuItem = 'block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface';

    return (
        <div className="fixed inset-x-0 bottom-[calc(var(--bottom-nav-offset,0px)+env(safe-area-inset-bottom))] transition-[bottom] md:bottom-0 z-30 border-t border-blue-100 bg-blue-50 shadow-[0_-2px_10px_rgba(15,23,42,0.06)] lg:sticky lg:inset-auto lg:top-6 lg:z-10 lg:w-fit lg:rounded-card lg:border lg:p-4 lg:shadow-sm">
            <div className="mx-auto flex max-w-[480px] flex-nowrap items-center gap-2 px-3 pt-3 pb-3 md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:mx-0 lg:w-max lg:flex-col lg:items-stretch lg:px-0 lg:py-0 lg:pb-0">
                <SaveEventButton eventId={event.event_id} eventTitle={event.title} appearance="pill" disabled={cancelled} className="shrink-0 border border-line lg:w-full" labelClassName="hidden min-[375px]:inline" />
                <GoingButton eventId={event.event_id} eventTitle={event.title} appearance="pill" isPast={isPast} ticketLikely={event.ticket_likely} cancelled={cancelled} className="shrink-0 border border-line lg:w-full" labelClassName="hidden min-[375px]:inline" />
                {reviewInline && (
                    <RateEventButton
                        eventId={event.event_id}
                        appearance="pill"
                        eventHasReviews={eventHasReviews}
                        autoOpenToken={reviewOpenToken}
                        entryPoint="detail"
                        isEventDetailPage
                        showCount={false}
                        isPast={isPast}
                        onRatingChanged={onRatingChanged}
                        actionStyle
                        className="lg:w-full"
                        labelClassName="hidden min-[375px]:inline"
                    />
                )}
                {!isPast && (
                    <ShareButton
                        eventId={event.event_id}
                        title={event.title}
                        url={shareUrl}
                        disabled={cancelled}
                        labelClassName="hidden min-[375px]:inline"
                        className="flex h-10 shrink-0 items-center gap-2 rounded-field border border-line bg-surface px-2 text-sm text-ink transition hover:bg-canvas lg:w-full"
                    />
                )}
                {showRatings && !isPast && (
                    <div className="hidden lg:block">
                        <RateEventButton
                            eventId={event.event_id}
                            appearance="pill"
                            eventHasReviews={eventHasReviews}
                            entryPoint="detail"
                            isEventDetailPage
                            showCount={false}
                            isPast={isPast}
                            onRatingChanged={onRatingChanged}
                            actionStyle
                            className="lg:w-full"
                        />
                    </div>
                )}
                {isPast && (
                    <ShareButton
                        eventId={event.event_id}
                        title={event.title}
                        url={shareUrl}
                        disabled={cancelled}
                        className={desktopButton}
                    />
                )}
                {ticket && (
                    <button type="button" onClick={() => setTicketOpen(true)} className={desktopButton}>
                        <Ticket className="h-4 w-4" aria-hidden="true" />
                        {ticket.label}
                    </button>
                )}
                <button type="button" onClick={onPostMessage} disabled={cancelled} className={desktopButton}>
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    Start discussion
                </button>
                {onSuggestEdit && (
                    <button type="button" onClick={onSuggestEdit} disabled={cancelled} className={desktopButton}>
                        <PencilLine className="h-4 w-4" aria-hidden="true" />
                        {suggestEditLabel}
                    </button>
                )}
                {organizerClaim.available && (
                    <button type="button" onClick={organizerClaim.start} className={desktopButton}>
                        <BadgeCheck className="h-4 w-4" aria-hidden="true" />
                        I organize this event
                    </button>
                )}
                {isOrganizer && (
                    <button type="button" onClick={() => setCancelOpen(true)} className={desktopButton}>
                        <CalendarX className="h-4 w-4" aria-hidden="true" />
                        {cancelLabel}
                    </button>
                )}
                {onAdminEdit && (
                    <button type="button" onClick={onAdminEdit} className={desktopButton}>
                        <Wrench className="h-4 w-4" aria-hidden="true" />
                        Admin Edit
                    </button>
                )}
                <div ref={menuRef} className="relative ml-auto shrink-0 lg:hidden">
                    <button
                        type="button"
                        onClick={() => setMenuOpen((o) => !o)}
                        aria-label="More actions"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-soft transition hover:bg-canvas"
                    >
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {menuOpen && (
                        <div
                            role="menu"
                            className="absolute right-0 bottom-full z-[12000] mb-1 w-44 rounded-lg border border-line bg-surface py-1 shadow-lg"
                        >
                            {showRatings && !isPast && (
                                <RateEventButton
                                    eventId={event.event_id}
                                    appearance="pill"
                                    eventHasReviews={eventHasReviews}
                                    entryPoint="detail"
                                    isEventDetailPage
                                    showCount={false}
                                    isPast={isPast}
                                    onRatingChanged={onRatingChanged}
                                />
                            )}
                            {isPast && (
                                <ShareButton
                                    eventId={event.event_id}
                                    title={event.title}
                                    url={shareUrl}
                                    disabled={cancelled}
                                    onAction={() => setMenuOpen(false)}
                                    className={menuItem}
                                />
                            )}
                            {ticket && !ticket.inline && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); setTicketOpen(true); }}
                                    className="block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas"
                                >
                                    {ticket.label}
                                </button>
                            )}
                            <button
                                type="button"
                                role="menuitem"
                                disabled={cancelled}
                                onClick={() => { setMenuOpen(false); onPostMessage(); }}
                                className={menuItem}
                            >
                                Start discussion
                            </button>
                            {onSuggestEdit && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={cancelled}
                                    onClick={() => { setMenuOpen(false); onSuggestEdit(); }}
                                    className={menuItem}
                                >
                                    {suggestEditLabel}
                                </button>
                            )}
                            {organizerClaim.available && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); organizerClaim.start(); }}
                                    className="block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas"
                                >
                                    I organize this event
                                </button>
                            )}
                            {isOrganizer && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); setCancelOpen(true); }}
                                    className="block w-full px-3 py-2 text-left text-xs text-danger transition hover:bg-canvas"
                                >
                                    {cancelLabel}
                                </button>
                            )}
                            {onAdminEdit && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); onAdminEdit(); }}
                                    className="block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas"
                                >
                                    Admin Edit
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
            {ticketOpen && <TicketSheet event={event} onClose={() => setTicketOpen(false)} />}
            {organizerClaim.sheet}
            {cancelOpen && (
                <CancelEventSheet
                    eventId={event.event_id}
                    eventTitle={event.title}
                    cancelled={event.is_cancelled}
                    onClose={() => setCancelOpen(false)}
                />
            )}
        </div>
    );
}
