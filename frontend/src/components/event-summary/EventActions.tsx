import { useState } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';
import { BadgeCheck, CalendarDays, Flag, MessageSquare, MoreHorizontal, PencilLine, Ticket, Wrench } from 'lucide-react';
import type { CalendarEvent } from '../../types';
import BottomSheet from '../BottomSheet';
import GoingButton from '../GoingButton';
import SaveEventButton from '../SaveEventButton';
import ShareButton from '../ShareButton';
import RateEventButton from '../RateEventButton';
import TicketSheet from '../TicketSheet';
import EventPromoCodeDialog from '../EventPromoCodeDialog';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import { useAuth } from '../../context/AuthContext';
import { useTicketAction } from '../../hooks/useTicketAction';
import useOrganizerClaimAction from '../../hooks/useOrganizerClaimAction';
import { useProgramEditorAccess } from '../../hooks/useProgramEditorAccess';
import { reportMailto } from '../../utils/report';
import { isPromoSectionVisible } from '../../utils/sectionVisibility';

interface Props {
    event: CalendarEvent;
    isPast: boolean;
    /** Show the Review action inline (user attended this or a prior edition);
     * otherwise it moves into the ••• overflow menu. */
    canReviewInline: boolean;
    shareUrl: string;
    reviewOpenToken?: number;
    onRatingChanged?: () => void;
    eventHasReviews?: boolean;
    /** Open the Discussion tab / composer (from "Post a message"). */
    onPostMessage: () => void;
    /** Optional "Suggest an edit" affordance. */
    onSuggestEdit?: () => void;
    /** Optional admin-only event editor affordance. */
    onAdminEdit?: () => void;
    /** Called after the viewer submits a promo code from the ••• menu. */
    onPromoAdded?: () => void;
    /** Called before leaving for the event or program editor (closes the modal). */
    onNavigate?: () => void;
}

/**
 * The action row that marks the end of EventSummary. Save and Going are the
 * slightly-emphasised actions; Review appears inline only when the viewer can
 * review, otherwise it lives in the ••• overflow menu alongside "Post a
 * message" and "Suggest an edit".
 */
export default function EventActions({
    event,
    isPast,
    canReviewInline,
    shareUrl,
    reviewOpenToken,
    onRatingChanged,
    eventHasReviews,
    onPostMessage,
    onSuggestEdit,
    onAdminEdit,
    onPromoAdded,
    onNavigate,
}: Props) {
    const { showRatings, promoCodesEnabled } = useFeatureFlags();
    const { user } = useAuth();
    const ticket = useTicketAction(event);
    const organizerClaim = useOrganizerClaimAction(event);
    const { isOrganizer, canEditProgram } = useProgramEditorAccess(event);
    const navigate = useNavigate();
    const location = useLocation();
    const [ticketOpen, setTicketOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [promoOpen, setPromoOpen] = useState(false);

    const reviewInline = showRatings && canReviewInline;
    const hasStarted = new Date(event.start).getTime() <= Date.now();
    const cancelled = Boolean(event.is_cancelled);
    const canAddPromo = Boolean(user) && !isPast && !cancelled && isPromoSectionVisible(event, promoCodesEnabled);
    const menuItem = 'flex min-h-12 w-full items-center gap-3 px-2 text-left text-base text-ink transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';
    const menuIcon = 'h-5 w-5 shrink-0 text-ink-soft';
    const openEditor = (path: string, state?: { backgroundLocation: Location }) => {
        setMenuOpen(false);
        onNavigate?.();
        navigate(path, { state });
    };
    const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation ?? location;

    return (
        <div className="flex w-full min-w-0 flex-nowrap items-center gap-1">
            {!isPast && <SaveEventButton eventId={event.event_id} eventTitle={event.title} appearance="pill" disabled={cancelled} className="shrink-0 border border-line" labelClassName="hidden min-[375px]:inline" />}
            <GoingButton eventId={event.event_id} eventTitle={event.title} appearance="pill" isPast={isPast} ticketLikely={event.ticket_likely && !isOrganizer} cancelled={cancelled} className="shrink-0 border border-line" labelClassName="hidden min-[375px]:inline" />
            {!isPast && (
                <ShareButton
                    eventId={event.event_id}
                    title={event.title}
                    url={shareUrl}
                    disabled={cancelled}
                    labelClassName="hidden min-[375px]:inline"
                    className="flex h-10 shrink-0 items-center gap-2 rounded-field border border-line bg-surface px-2 text-sm text-ink transition hover:bg-canvas"
                />
            )}
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
                    hasStarted={hasStarted}
                    onRatingChanged={onRatingChanged}
                    actionStyle
                    labelClassName="hidden min-[375px]:inline"
                />
            )}
            <div className="relative ml-auto shrink-0">
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
                    <BottomSheet title="More actions" subtitle={event.title} variant="floating" compact desktop="modal" onClose={() => setMenuOpen(false)}>
                        <div role="menu" className="flex flex-col">
                            {showRatings && !reviewInline && (
                                <RateEventButton
                                    eventId={event.event_id}
                                    appearance="menuItem"
                                    eventHasReviews={eventHasReviews}
                                    entryPoint="detail"
                                    isEventDetailPage
                                    showCount={false}
                                    isPast={isPast}
                                    hasStarted={hasStarted}
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
                                    iconClassName={menuIcon}
                                />
                            )}
                            {ticket && !ticket.inline && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); setTicketOpen(true); }}
                                    className={menuItem}
                                >
                                    <Ticket className={menuIcon} aria-hidden="true" />
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
                                <MessageSquare className={menuIcon} aria-hidden="true" />
                                Post a message
                            </button>
                            {canAddPromo && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); setPromoOpen(true); }}
                                    className={menuItem}
                                >
                                    <img src="/promo-code.png" alt="" aria-hidden="true" className="h-5 w-5 shrink-0 object-contain" />
                                    Add promo code
                                </button>
                            )}
                            {isOrganizer ? (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => openEditor(`/event/${event.event_id}/suggest-change`, { backgroundLocation })}
                                    className={menuItem}
                                >
                                    <PencilLine className={menuIcon} aria-hidden="true" />
                                    Edit event
                                </button>
                            ) : onSuggestEdit && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={cancelled}
                                    onClick={() => { setMenuOpen(false); onSuggestEdit(); }}
                                    className={menuItem}
                                >
                                    <PencilLine className={menuIcon} aria-hidden="true" />
                                    Suggest an edit
                                </button>
                            )}
                            {canEditProgram && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => openEditor(`/event/${event.event_id}/program/edit`)}
                                    className={menuItem}
                                >
                                    <CalendarDays className={menuIcon} aria-hidden="true" />
                                    Edit program
                                </button>
                            )}
                            {organizerClaim.available && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); organizerClaim.start(); }}
                                    className={menuItem}
                                >
                                    <BadgeCheck className={menuIcon} aria-hidden="true" />
                                    I organize this event
                                </button>
                            )}
                            {onAdminEdit && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); onAdminEdit(); }}
                                    className={menuItem}
                                >
                                    <Wrench className={menuIcon} aria-hidden="true" />
                                    Admin Edit
                                </button>
                            )}
                            <a
                                role="menuitem"
                                href={reportMailto('event', `${window.location.origin}/event/${event.event_id}`, event.title)}
                                onClick={() => setMenuOpen(false)}
                                className="flex min-h-12 w-full items-center gap-3 px-2 text-left text-base text-ink-soft transition hover:bg-canvas"
                            >
                                <Flag className={menuIcon} aria-hidden="true" />
                                Report or request removal
                            </a>
                        </div>
                    </BottomSheet>
                )}
            </div>
            {ticketOpen && <TicketSheet event={event} onClose={() => setTicketOpen(false)} />}
            {promoOpen && (
                <EventPromoCodeDialog
                    eventId={event.event_id}
                    onClose={() => setPromoOpen(false)}
                    onSubmitted={() => onPromoAdded?.()}
                />
            )}
            {organizerClaim.sheet}
        </div>
    );
}
