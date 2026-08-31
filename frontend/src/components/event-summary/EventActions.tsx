import { useEffect, useRef, useState } from 'react';
import type { CalendarEvent } from '../../types';
import GoingButton from '../GoingButton';
import SaveEventButton from '../SaveEventButton';
import ShareButton from '../ShareButton';
import RateEventButton from '../RateEventButton';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';

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
}: Props) {
    const { showRatings } = useFeatureFlags();
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

    const reviewInline = showRatings && canReviewInline;

    return (
        <div className="flex items-center gap-2">
            <SaveEventButton eventId={event.event_id} appearance="pill" />
            <GoingButton eventId={event.event_id} appearance="pill" isPast={isPast} />
            <ShareButton
                eventId={event.event_id}
                title={event.title}
                url={shareUrl}
                className="inline-flex shrink-0 items-center border border-line bg-surface px-2.5 py-1 text-xs text-ink transition hover:bg-canvas"
            />
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
                />
            )}
            <div ref={menuRef} className="relative ml-auto">
                <button
                    type="button"
                    onClick={() => setMenuOpen((o) => !o)}
                    aria-label="More actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-line bg-surface text-ink-soft transition hover:bg-canvas"
                >
                    <span aria-hidden="true">•••</span>
                </button>
                {menuOpen && (
                    <div
                        role="menu"
                        className="absolute right-0 bottom-full z-[12000] mb-1 w-44 border border-line bg-surface py-1 shadow-lg"
                    >
                        {showRatings && !canReviewInline && (
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
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => { setMenuOpen(false); onPostMessage(); }}
                            className="block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas"
                        >
                            Post a message
                        </button>
                        {onSuggestEdit && (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => { setMenuOpen(false); onSuggestEdit(); }}
                                className="block w-full px-3 py-2 text-left text-xs text-ink transition hover:bg-canvas"
                            >
                                Suggest an edit
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
